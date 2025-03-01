/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FetchStatus, CustomSignals } from '@firebase/remote-config-types';
import { FetchResponse, FirebaseRemoteConfigObject } from '../public_types';
import { ERROR_FACTORY, ErrorCode } from '../errors';
import { RC_CUSTOM_SIGNAL_MAX_ALLOWED_SIGNALS } from '../constants';
import { FirebaseError } from '@firebase/util';

/**
 * Converts an error event associated with a {@link IDBRequest} to a {@link FirebaseError}.
 */
function toFirebaseError(event: Event, errorCode: ErrorCode): FirebaseError {
  const originalError = (event.target as IDBRequest).error || undefined;
  return ERROR_FACTORY.create(errorCode, {
    originalErrorMessage: originalError && (originalError as Error)?.message
  });
}

/**
 * A general-purpose store keyed by app + namespace + {@link
 * ProjectNamespaceKeyFieldValue}.
 *
 * <p>The Remote Config SDK can be used with multiple app installations, and each app can interact
 * with multiple namespaces, so this store uses app (ID + name) and namespace as common parent keys
 * for a set of key-value pairs. See {@link Storage#createCompositeKey}.
 *
 * <p>Visible for testing.
 */
export const APP_NAMESPACE_STORE = 'app_namespace_store';

const DB_NAME = 'firebase_remote_config';
const DB_VERSION = 1;

/**
 * Encapsulates metadata concerning throttled fetch requests.
 */
export interface ThrottleMetadata {
  // The number of times fetch has backed off. Used for resuming backoff after a timeout.
  backoffCount: number;
  // The Unix timestamp in milliseconds when callers can retry a request.
  throttleEndTimeMillis: number;
}

/**
 * Provides type-safety for the "key" field used by {@link APP_NAMESPACE_STORE}.
 *
 * <p>This seems like a small price to avoid potentially subtle bugs caused by a typo.
 */
type ProjectNamespaceKeyFieldValue =
  | 'active_config'
  | 'active_config_etag'
  | 'last_fetch_status'
  | 'last_successful_fetch_timestamp_millis'
  | 'last_successful_fetch_response'
  | 'settings'
  | 'throttle_metadata'
  | 'custom_signals';

// Visible for testing.
export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = event => {
        reject(toFirebaseError(event, ErrorCode.STORAGE_OPEN));
      };
      request.onsuccess = event => {
        resolve((event.target as IDBOpenDBRequest).result);
      };
      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result;

        // We don't use 'break' in this switch statement, the fall-through
        // behavior is what we want, because if there are multiple versions between
        // the old version and the current version, we want ALL the migrations
        // that correspond to those versions to run, not only the last one.
        // eslint-disable-next-line default-case
        switch (event.oldVersion) {
          case 0:
            db.createObjectStore(APP_NAMESPACE_STORE, {
              keyPath: 'compositeKey'
            });
        }
      };
    } catch (error) {
      reject(
        ERROR_FACTORY.create(ErrorCode.STORAGE_OPEN, {
          originalErrorMessage: (error as Error)?.message
        })
      );
    }
  });
}

/**
 * Abstracts data persistence.
 */
export abstract class Storage {
  getLastFetchStatus(): Promise<FetchStatus | undefined> {
    return this.get<FetchStatus>('last_fetch_status');
  }

  setLastFetchStatus(status: FetchStatus): Promise<void> {
    return this.set<FetchStatus>('last_fetch_status', status);
  }

  // This is comparable to a cache entry timestamp. If we need to expire other data, we could
  // consider adding timestamp to all storage records and an optional max age arg to getters.
  getLastSuccessfulFetchTimestampMillis(): Promise<number | undefined> {
    return this.get<number>('last_successful_fetch_timestamp_millis');
  }

  setLastSuccessfulFetchTimestampMillis(timestamp: number): Promise<void> {
    return this.set<number>(
      'last_successful_fetch_timestamp_millis',
      timestamp
    );
  }

  getLastSuccessfulFetchResponse(): Promise<FetchResponse | undefined> {
    return this.get<FetchResponse>('last_successful_fetch_response');
  }

  setLastSuccessfulFetchResponse(response: FetchResponse): Promise<void> {
    return this.set<FetchResponse>('last_successful_fetch_response', response);
  }

  getActiveConfig(): Promise<FirebaseRemoteConfigObject | undefined> {
    return this.get<FirebaseRemoteConfigObject>('active_config');
  }

  setActiveConfig(config: FirebaseRemoteConfigObject): Promise<void> {
    return this.set<FirebaseRemoteConfigObject>('active_config', config);
  }

  getActiveConfigEtag(): Promise<string | undefined> {
    return this.get<string>('active_config_etag');
  }

  setActiveConfigEtag(etag: string): Promise<void> {
    return this.set<string>('active_config_etag', etag);
  }

  getThrottleMetadata(): Promise<ThrottleMetadata | undefined> {
    return this.get<ThrottleMetadata>('throttle_metadata');
  }

  setThrottleMetadata(metadata: ThrottleMetadata): Promise<void> {
    return this.set<ThrottleMetadata>('throttle_metadata', metadata);
  }

  deleteThrottleMetadata(): Promise<void> {
    return this.delete('throttle_metadata');
  }

  getCustomSignals(): Promise<CustomSignals | undefined> {
    return this.get<CustomSignals>('custom_signals');
  }

  abstract setCustomSignals(
    customSignals: CustomSignals
  ): Promise<CustomSignals>;
  abstract get<T>(key: ProjectNamespaceKeyFieldValue): Promise<T | undefined>;
  abstract set<T>(key: ProjectNamespaceKeyFieldValue, value: T): Promise<void>;
  abstract delete(key: ProjectNamespaceKeyFieldValue): Promise<void>;
}

export class IndexedDbStorage extends Storage {
  /**
   * @param appId enables storage segmentation by app (ID + name).
   * @param appName enables storage segmentation by app (ID + name).
   * @param namespace enables storage segmentation by namespace.
   */
  constructor(
    private readonly appId: string,
    private readonly appName: string,
    private readonly namespace: string,
    private readonly openDbPromise = openDatabase()
  ) {
    super();
  }

  async setCustomSignals(customSignals: CustomSignals): Promise<CustomSignals> {
    const db = await this.openDbPromise;
    const transaction = db.transaction([APP_NAMESPACE_STORE], 'readwrite');
    const storedSignals = await this.getWithTransaction<CustomSignals>(
      'custom_signals',
      transaction
    );
    const updatedSignals = mergeCustomSignals(
      customSignals,
      storedSignals || {}
    );
    await this.setWithTransaction<CustomSignals>(
      'custom_signals',
      updatedSignals,
      transaction
    );
    return updatedSignals;
  }

  /**
   * Gets a value from the database using the provided transaction.
   *
   * @param key The key of the value to get.
   * @param transaction The transaction to use for the operation.
   * @returns The value associated with the key, or undefined if no such value exists.
   */
  async getWithTransaction<T>(
    key: ProjectNamespaceKeyFieldValue,
    transaction: IDBTransaction
  ): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const objectStore = transaction.objectStore(APP_NAMESPACE_STORE);
      const compositeKey = this.createCompositeKey(key);
      try {
        const request = objectStore.get(compositeKey);
        request.onerror = event => {
          reject(toFirebaseError(event, ErrorCode.STORAGE_GET));
        };
        request.onsuccess = event => {
          const result = (event.target as IDBRequest).result;
          if (result) {
            resolve(result.value);
          } else {
            resolve(undefined);
          }
        };
      } catch (e) {
        reject(
          ERROR_FACTORY.create(ErrorCode.STORAGE_GET, {
            originalErrorMessage: (e as Error)?.message
          })
        );
      }
    });
  }

  /**
   * Sets a value in the database using the provided transaction.
   *
   * @param key The key of the value to set.
   * @param value The value to set.
   * @param transaction The transaction to use for the operation.
   * @returns A promise that resolves when the operation is complete.
   */
  async setWithTransaction<T>(
    key: ProjectNamespaceKeyFieldValue,
    value: T,
    transaction: IDBTransaction
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const objectStore = transaction.objectStore(APP_NAMESPACE_STORE);
      const compositeKey = this.createCompositeKey(key);
      try {
        const request = objectStore.put({
          compositeKey,
          value
        });
        request.onerror = (event: Event) => {
          reject(toFirebaseError(event, ErrorCode.STORAGE_SET));
        };
        request.onsuccess = () => {
          resolve();
        };
      } catch (e) {
        reject(
          ERROR_FACTORY.create(ErrorCode.STORAGE_SET, {
            originalErrorMessage: (e as Error)?.message
          })
        );
      }
    });
  }

  async get<T>(key: ProjectNamespaceKeyFieldValue): Promise<T | undefined> {
    const db = await this.openDbPromise;
    const transaction = db.transaction([APP_NAMESPACE_STORE], 'readonly');
    return this.getWithTransaction<T>(key, transaction);
  }

  async set<T>(key: ProjectNamespaceKeyFieldValue, value: T): Promise<void> {
    const db = await this.openDbPromise;
    const transaction = db.transaction([APP_NAMESPACE_STORE], 'readwrite');
    return this.setWithTransaction<T>(key, value, transaction);
  }

  async delete(key: ProjectNamespaceKeyFieldValue): Promise<void> {
    const db = await this.openDbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([APP_NAMESPACE_STORE], 'readwrite');
      const objectStore = transaction.objectStore(APP_NAMESPACE_STORE);
      const compositeKey = this.createCompositeKey(key);
      try {
        const request = objectStore.delete(compositeKey);
        request.onerror = (event: Event) => {
          reject(toFirebaseError(event, ErrorCode.STORAGE_DELETE));
        };
        request.onsuccess = () => {
          resolve();
        };
      } catch (e) {
        reject(
          ERROR_FACTORY.create(ErrorCode.STORAGE_DELETE, {
            originalErrorMessage: (e as Error)?.message
          })
        );
      }
    });
  }

  // Facilitates composite key functionality (which is unsupported in IE).
  createCompositeKey(key: ProjectNamespaceKeyFieldValue): string {
    return [this.appId, this.appName, this.namespace, key].join();
  }
}

export class InMemoryStorage extends Storage {
  private storage: { [key: string]: unknown } = {};

  async get<T>(key: ProjectNamespaceKeyFieldValue): Promise<T> {
    return Promise.resolve(this.storage[key] as T);
  }

  async set<T>(key: ProjectNamespaceKeyFieldValue, value: T): Promise<void> {
    this.storage[key] = value;
    return Promise.resolve(undefined);
  }

  async delete(key: ProjectNamespaceKeyFieldValue): Promise<void> {
    this.storage[key] = undefined;
    return Promise.resolve();
  }

  async setCustomSignals(customSignals: CustomSignals): Promise<CustomSignals> {
    const storedSignals = (this.storage['custom_signals'] ||
      {}) as CustomSignals;
    this.storage['custom_signals'] = mergeCustomSignals(
      customSignals,
      storedSignals
    );
    return Promise.resolve(this.storage['custom_signals'] as CustomSignals);
  }
}

function mergeCustomSignals(
  customSignals: CustomSignals,
  storedSignals: CustomSignals
): CustomSignals {
  const combinedSignals = {
    ...storedSignals,
    ...customSignals
  };

  // Filter out key-value assignments with null values since they are signals being unset
  const updatedSignals = Object.fromEntries(
    Object.entries(combinedSignals)
      .filter(([_, v]) => v !== null)
      .map(([k, v]) => {
        // Stringify numbers to store a map of string keys and values which can be sent
        // as-is in a fetch call.
        if (typeof v === 'number') {
          return [k, v.toString()];
        }
        return [k, v];
      })
  );

  // Throw an error if the number of custom signals to be stored exceeds the limit
  if (
    Object.keys(updatedSignals).length > RC_CUSTOM_SIGNAL_MAX_ALLOWED_SIGNALS
  ) {
    throw ERROR_FACTORY.create(ErrorCode.CUSTOM_SIGNAL_MAX_ALLOWED_SIGNALS, {
      maxSignals: RC_CUSTOM_SIGNAL_MAX_ALLOWED_SIGNALS
    });
  }
  return updatedSignals;
}
