export interface StoredRecord<TValue> {
  readonly key: string;
  readonly value: TValue;
  readonly version?: string;
  readonly updatedAt: string;
}

export interface StateStore {
  get<TValue>(key: string): Promise<StoredRecord<TValue> | null>;
  set<TValue>(key: string, value: TValue, options?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
