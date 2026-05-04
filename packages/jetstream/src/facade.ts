/**
 * Thin facade over the NATS / JetStream client APIs that every Friday
 * surface ends up needing. Centralizes:
 *   - idempotent `getOrCreate*` semantics for streams / KV / object stores
 *   - the JetStreamManager handle (one async resolution, then cached)
 *   - escape hatches (`nc`, `js`) for callers that need raw access
 *
 * Not a leaky-abstraction layer — it deliberately exposes the underlying
 * `nats` types (`StreamConfig`, `KvOptions`, etc.) rather than wrapping
 * them. Callers can drop down to `facade.nc.jetstream()` whenever they
 * need something the facade doesn't cover.
 */

import type {
  JetStreamClient,
  JetStreamManager,
  KV,
  KvOptions,
  NatsConnection,
  ObjectStore,
  ObjectStoreOptions,
  StreamConfig,
  StreamInfo,
} from "nats";
import { isStreamNotFound } from "./helpers.ts";

export interface JetStreamFacade {
  /** Underlying NATS connection. */
  readonly nc: NatsConnection;
  /** Cached JetStream client (cheap; safe to share). */
  readonly js: JetStreamClient;
  /** Resolves the JetStreamManager (admin ops). Cached after first call. */
  jsm(): Promise<JetStreamManager>;

  stream: {
    /**
     * Idempotent: returns existing stream info if the stream exists with
     * any config, otherwise creates with the supplied config. Does NOT
     * reconcile config differences — use `update` for that.
     */
    getOrCreate(name: string, config: Partial<StreamConfig>): Promise<StreamInfo>;
    info(name: string): Promise<StreamInfo | null>;
    update(name: string, config: Partial<StreamConfig>): Promise<StreamInfo>;
    delete(name: string): Promise<void>;
    purge(name: string): Promise<void>;
  };

  kv: {
    /** Idempotent: get-or-create. nats.js `views.kv` is already idempotent. */
    getOrCreate(bucket: string, options?: Partial<KvOptions>): Promise<KV>;
    delete(bucket: string): Promise<void>;
  };

  os: {
    /** Idempotent: get-or-create object store (for blobs > KV value limit). */
    getOrCreate(name: string, options?: Partial<ObjectStoreOptions>): Promise<ObjectStore>;
    delete(name: string): Promise<void>;
  };
}

export function createJetStreamFacade(nc: NatsConnection): JetStreamFacade {
  const js = nc.jetstream();
  let cachedJsm: Promise<JetStreamManager> | null = null;
  function jsm(): Promise<JetStreamManager> {
    if (!cachedJsm) cachedJsm = nc.jetstreamManager();
    return cachedJsm;
  }

  return {
    nc,
    js,
    jsm,

    stream: {
      async getOrCreate(name: string, config: Partial<StreamConfig>): Promise<StreamInfo> {
        const m = await jsm();
        try {
          return await m.streams.info(name);
        } catch (err) {
          if (!isStreamNotFound(err)) throw err;
        }
        return await m.streams.add({ name, ...config } as StreamConfig);
      },
      async info(name: string): Promise<StreamInfo | null> {
        const m = await jsm();
        try {
          return await m.streams.info(name);
        } catch (err) {
          if (isStreamNotFound(err)) return null;
          throw err;
        }
      },
      async update(name: string, config: Partial<StreamConfig>): Promise<StreamInfo> {
        const m = await jsm();
        return await m.streams.update(name, config);
      },
      async delete(name: string): Promise<void> {
        const m = await jsm();
        try {
          await m.streams.delete(name);
        } catch (err) {
          if (!isStreamNotFound(err)) throw err;
        }
      },
      async purge(name: string): Promise<void> {
        const m = await jsm();
        await m.streams.purge(name);
      },
    },

    kv: {
      async getOrCreate(bucket: string, options: Partial<KvOptions> = {}): Promise<KV> {
        // `views.kv` is documented as get-or-create; we just centralize the
        // call site so future cross-cutting concerns (logging, metrics) hook
        // in one place.
        return await js.views.kv(bucket, options as KvOptions);
      },
      async delete(bucket: string): Promise<void> {
        const m = await jsm();
        try {
          await m.streams.delete(`KV_${bucket}`);
        } catch (err) {
          if (!isStreamNotFound(err)) throw err;
        }
      },
    },

    os: {
      async getOrCreate(
        name: string,
        options: Partial<ObjectStoreOptions> = {},
      ): Promise<ObjectStore> {
        return await js.views.os(name, options as ObjectStoreOptions);
      },
      async delete(name: string): Promise<void> {
        const m = await jsm();
        try {
          await m.streams.delete(`OBJ_${name}`);
        } catch (err) {
          if (!isStreamNotFound(err)) throw err;
        }
      },
    },
  };
}
