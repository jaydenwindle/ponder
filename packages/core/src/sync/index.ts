import type { Common } from "@/internal/common.js";
import type {
  Factory,
  IndexingBuild,
  Network,
  RawEvent,
  Source,
  Status,
} from "@/internal/types.js";
import {
  type HistoricalSync,
  createHistoricalSync,
} from "@/sync-historical/index.js";
import {
  type RealtimeSync,
  type RealtimeSyncEvent,
  createRealtimeSync,
} from "@/sync-realtime/index.js";
import type { SyncStore } from "@/sync-store/index.js";
import type { LightBlock, SyncBlock } from "@/types/sync.js";
import {
  type Checkpoint,
  decodeCheckpoint,
  encodeCheckpoint,
  maxCheckpoint,
  zeroCheckpoint,
} from "@/utils/checkpoint.js";
import { estimate } from "@/utils/estimate.js";
import { formatEta, formatPercentage } from "@/utils/format.js";
import { mergeAsyncGenerators } from "@/utils/generators.js";
import {
  type Interval,
  intervalDifference,
  intervalIntersection,
  intervalIntersectionMany,
  intervalSum,
  sortIntervals,
} from "@/utils/interval.js";
import { intervalUnion } from "@/utils/interval.js";
import { never } from "@/utils/never.js";
import { type RequestQueue, createRequestQueue } from "@/utils/requestQueue.js";
import { startClock } from "@/utils/timer.js";
import { type Queue, createQueue } from "@ponder/common";
import {
  type Address,
  type Hash,
  type Transport,
  hexToBigInt,
  hexToNumber,
  toHex,
} from "viem";
import { _eth_getBlockByNumber } from "../utils/rpc.js";
import { buildEvents } from "./events.js";
import { isAddressFactory } from "./filter.js";
import { cachedTransport } from "./transport.js";

export type Sync = {
  getEvents(): AsyncGenerator<{ events: RawEvent[]; checkpoint: string }>;
  startRealtime(): Promise<void>;
  getStatus(): Status;
  getStartCheckpoint(): string;
  getFinalizedCheckpoint(): string;
  getCachedTransport(network: Network): Transport;
  kill(): Promise<void>;
};

export type RealtimeEvent =
  | {
      type: "block";
      checkpoint: string;
      status: Status;
      events: RawEvent[];
    }
  | {
      type: "reorg";
      checkpoint: string;
    }
  | {
      type: "finalize";
      checkpoint: string;
    };

export type SyncProgress = {
  start: SyncBlock | LightBlock;
  end: SyncBlock | LightBlock | undefined;
  cached: SyncBlock | LightBlock | undefined;
  current: SyncBlock | LightBlock | undefined;
  finalized: SyncBlock | LightBlock;
};

export const syncBlockToLightBlock = ({
  hash,
  parentHash,
  number,
  timestamp,
}: SyncBlock): LightBlock => ({
  hash,
  parentHash,
  number,
  timestamp,
});

/** Convert `block` to a `Checkpoint`. */
export const blockToCheckpoint = (
  block: LightBlock | SyncBlock,
  chainId: number,
  rounding: "up" | "down",
): Checkpoint => {
  return {
    ...(rounding === "up" ? maxCheckpoint : zeroCheckpoint),
    blockTimestamp: hexToNumber(block.timestamp),
    chainId: BigInt(chainId),
    blockNumber: hexToBigInt(block.number),
  };
};

/**
 * Returns true if all filters have a defined end block and the current
 * sync progress has reached the final end block.
 */
const isSyncEnd = (syncProgress: SyncProgress) => {
  if (syncProgress.end === undefined || syncProgress.current === undefined) {
    return false;
  }

  return (
    hexToNumber(syncProgress.current.number) >=
    hexToNumber(syncProgress.end.number)
  );
};

/** Returns true if sync progress has reached the finalized block. */
const isSyncFinalized = (syncProgress: SyncProgress) => {
  if (syncProgress.current === undefined) {
    return false;
  }

  return (
    hexToNumber(syncProgress.current.number) >=
    hexToNumber(syncProgress.finalized.number)
  );
};

/** Returns the closest-to-tip block that is part of the historical sync. */
const getHistoricalLast = (
  syncProgress: Pick<SyncProgress, "finalized" | "end">,
) => {
  return syncProgress.end === undefined
    ? syncProgress.finalized
    : hexToNumber(syncProgress.end.number) >
        hexToNumber(syncProgress.finalized.number)
      ? syncProgress.finalized
      : syncProgress.end;
};

/** Compute the minimum checkpoint, filtering out undefined */
const min = (...checkpoints: (string | undefined)[]) => {
  return checkpoints.reduce((acc, cur) => {
    if (cur === undefined) return acc;
    if (acc === undefined) return cur;
    if (acc < cur) return acc;
    return cur;
  })!;
};

export const splitEvents = (
  events: RawEvent[],
): { checkpoint: string; events: RawEvent[] }[] => {
  let prevHash: Hash | undefined;
  const result: { checkpoint: string; events: RawEvent[] }[] = [];

  for (const event of events) {
    if (prevHash === undefined || prevHash !== event.block.hash) {
      result.push({
        checkpoint: encodeCheckpoint({
          ...maxCheckpoint,
          blockTimestamp: Number(event.block.timestamp),
          chainId: BigInt(event.chainId),
          blockNumber: event.block.number,
        }),
        events: [],
      });
      prevHash = event.block.hash;
    }

    result[result.length - 1]!.events.push(event);
  }

  return result;
};

/** Returns the checkpoint for a given block tag. */
export const getChainCheckpoint = ({
  syncProgress,
  network,
  tag,
}: {
  syncProgress: SyncProgress;
  network: Network;
  tag: "start" | "current" | "finalized" | "end";
}): string | undefined => {
  if (tag === "end" && syncProgress.end === undefined) {
    return undefined;
  }

  if (tag === "current" && isSyncEnd(syncProgress)) {
    return undefined;
  }

  const block = syncProgress[tag]!;
  return encodeCheckpoint(
    blockToCheckpoint(
      block,
      network.chainId,
      // The checkpoint returned by this function is meant to be used in
      // a closed interval (includes endpoints), so "start" should be inclusive.
      tag === "start" ? "down" : "up",
    ),
  );
};

type CreateSyncParameters = {
  common: Common;
  indexingBuild: Pick<IndexingBuild, "sources" | "networks">;
  syncStore: SyncStore;
  onRealtimeEvent(event: RealtimeEvent): Promise<void>;
  onFatalError(error: Error): void;
  initialCheckpoint: string;
};

export const createSync = async (args: CreateSyncParameters): Promise<Sync> => {
  const perNetworkSync = new Map<
    Network,
    {
      requestQueue: RequestQueue;
      syncProgress: SyncProgress;
      historicalSync: HistoricalSync;
      realtimeSync: RealtimeSync;
      realtimeQueue: Queue<void, RealtimeSyncEvent>;
      unfinalizedBlocks: Omit<
        Extract<RealtimeSyncEvent, { type: "block" }>,
        "type"
      >[];
    }
  >();
  /** Events that have been executed but not finalized. */
  let executedEvents: RawEvent[] = [];
  /** Events that have not been executed yet. */
  let pendingEvents: RawEvent[] = [];
  const status: Status = {};
  let isKilled = false;
  // Realtime events across all chains that can't be passed to the parent function
  // because the overall checkpoint hasn't caught up to the events yet.

  // Instantiate `localSyncData` and `status`
  await Promise.all(
    args.indexingBuild.networks.map(async (network) => {
      const requestQueue = createRequestQueue({
        network,
        common: args.common,
      });
      const sources = args.indexingBuild.sources.filter(
        ({ filter }) => filter.chainId === network.chainId,
      );

      const { start, end, finalized } = await syncDiagnostic({
        common: args.common,
        sources,
        requestQueue,
        network,
      });

      // Invalidate sync cache for devnet sources
      if (network.disableCache) {
        args.common.logger.warn({
          service: "sync",
          msg: `Deleting cache records for '${network.name}' from block ${hexToNumber(start.number)}`,
        });

        await args.syncStore.pruneByChain({
          fromBlock: hexToNumber(start.number),
          chainId: network.chainId,
        });
      }

      const historicalSync = await createHistoricalSync({
        common: args.common,
        sources,
        syncStore: args.syncStore,
        requestQueue,
        network,
        onFatalError: args.onFatalError,
      });

      const realtimeQueue = createQueue({
        initialStart: true,
        browser: false,
        concurrency: 1,
        worker: async (event: RealtimeSyncEvent) =>
          onRealtimeSyncEvent({ event, network }),
      });

      const realtimeSync = createRealtimeSync({
        common: args.common,
        sources,
        requestQueue,
        network,
        onEvent: (event) =>
          realtimeQueue.add(event).catch((error) => {
            args.common.logger.error({
              service: "sync",
              msg: `Fatal error: Unable to process ${event.type} event`,
              error,
            });
            args.onFatalError(error);
          }),
        onFatalError: args.onFatalError,
      });

      const cached = await getCachedBlock({
        sources,
        requestQueue,
        historicalSync,
      });

      // Update "ponder_sync_block" metric
      if (cached !== undefined) {
        args.common.metrics.ponder_sync_block.set(
          { network: network.name },
          hexToNumber(cached.number),
        );
      }

      const syncProgress: SyncProgress = {
        start,
        end,
        finalized,
        cached,
        current: cached,
      };

      args.common.metrics.ponder_sync_is_realtime.set(
        { network: network.name },
        0,
      );
      args.common.metrics.ponder_sync_is_complete.set(
        { network: network.name },
        0,
      );

      perNetworkSync.set(network, {
        requestQueue,
        syncProgress,
        historicalSync,
        realtimeSync,
        realtimeQueue,
        unfinalizedBlocks: [],
      });
      status[network.name] = { block: null, ready: false };
    }),
  );

  /**
   * Returns the minimum checkpoint across all chains.
   */
  const getOmnichainCheckpoint = (
    tag: "start" | "end" | "current" | "finalized",
  ): string | undefined => {
    const checkpoints = Array.from(perNetworkSync.entries()).map(
      ([network, { syncProgress }]) =>
        getChainCheckpoint({ syncProgress, network, tag }),
    );

    if (tag === "end" && checkpoints.some((c) => c === undefined)) {
      return undefined;
    }

    if (tag === "current" && checkpoints.every((c) => c === undefined)) {
      return undefined;
    }

    return min(...checkpoints);
  };

  const updateHistoricalStatus = ({
    events,
    checkpoint,
    network,
  }: { events: RawEvent[]; checkpoint: string; network: Network }) => {
    if (Number(decodeCheckpoint(checkpoint).chainId) === network.chainId) {
      status[network.name]!.block = {
        timestamp: decodeCheckpoint(checkpoint).blockTimestamp,
        number: Number(decodeCheckpoint(checkpoint).blockNumber),
      };
    } else {
      let i = events.length - 1;
      while (i >= 0) {
        const event = events[i]!;

        if (network.chainId === event.chainId) {
          status[network.name]!.block = {
            timestamp: decodeCheckpoint(event.checkpoint).blockTimestamp,
            number: Number(decodeCheckpoint(event.checkpoint).blockNumber),
          };
        }

        i--;
      }
    }
  };

  const updateRealtimeStatus = ({
    checkpoint,
    network,
  }: {
    checkpoint: string;
    network: Network;
  }) => {
    const localBlock = perNetworkSync
      .get(network)!
      .realtimeSync.unfinalizedBlocks.findLast(
        (block) =>
          encodeCheckpoint(blockToCheckpoint(block, network.chainId, "up")) <=
          checkpoint,
      );
    if (localBlock !== undefined) {
      status[network.name]!.block = {
        timestamp: hexToNumber(localBlock.timestamp),
        number: hexToNumber(localBlock.number),
      };
    }
  };

  /**
   * Estimate optimal range (seconds) to query at a time, eventually
   * used to determine `to` passed to `getEvents`
   */
  let estimateSeconds = 1_000;
  /**
   * Omnichain `getEvents`
   *
   * Extract all events across `args.networks` ordered by checkpoint.
   * The generator is "completed" when all event have been extracted
   * before the minimum finalized checkpoint (supremum).
   *
   * Note: `syncStore.getEvents` is used to order between multiple
   * networks. This approach is not future proof.
   */
  async function* getEvents() {
    let latestFinalizedFetch = Date.now();

    /**
     * Calculate start checkpoint, if `initialCheckpoint` is non-zero,
     * use that. Otherwise, use `startBlock`
     */
    const start =
      args.initialCheckpoint !== encodeCheckpoint(zeroCheckpoint)
        ? args.initialCheckpoint
        : getOmnichainCheckpoint("start")!;

    // Cursor used to track progress.
    let from = start;

    let showLogs = true;
    while (true) {
      const syncGenerator = mergeAsyncGenerators(
        Array.from(perNetworkSync.entries()).map(
          ([network, { syncProgress, historicalSync }]) =>
            localHistoricalSyncGenerator({
              common: args.common,
              network,
              syncProgress,
              historicalSync,
              showLogs,
            }),
        ),
      );

      // Only show logs on the first iteration
      showLogs = false;

      for await (const _ of syncGenerator) {
        /**
         * `current` is used to calculate the `to` checkpoint, if any
         * network hasn't yet ingested a block, run another iteration of this loop.
         * It is an invariant that `latestBlock` will eventually be defined.
         */
        if (
          Array.from(perNetworkSync.values()).some(
            ({ syncProgress }) => syncProgress.current === undefined,
          )
        ) {
          continue;
        }

        // Calculate the mininum "current" checkpoint, limited by "finalized" and "end"
        const to = min(
          getOmnichainCheckpoint("end"),
          getOmnichainCheckpoint("finalized"),
          getOmnichainCheckpoint("current"),
        );

        let consecutiveErrors = 0;

        /*
         * Extract events with `syncStore.getEvents()`, paginating to
         * avoid loading too many events into memory.
         */
        while (true) {
          if (isKilled) return;
          if (from >= to) break;
          const getEventsMaxBatchSize = args.common.options.syncEventsQuerySize;

          // convert `estimateSeconds` to checkpoint
          const estimatedTo = encodeCheckpoint({
            ...zeroCheckpoint,
            blockTimestamp: Math.min(
              decodeCheckpoint(from).blockTimestamp + estimateSeconds,
              maxCheckpoint.blockTimestamp,
            ),
          });

          try {
            const { events, cursor } = await args.syncStore.getEvents({
              filters: args.indexingBuild.sources.map(({ filter }) => filter),
              from,
              to: to < estimatedTo ? to : estimatedTo,
              limit: getEventsMaxBatchSize,
            });

            args.common.logger.debug({
              service: "sync",
              msg: `Fetched ${events.length} events from the database for a ${formatEta(estimateSeconds * 1000)} range from timestamp ${decodeCheckpoint(from).blockTimestamp}`,
            });

            for (const network of args.indexingBuild.networks) {
              updateHistoricalStatus({ events, checkpoint: cursor, network });
            }

            estimateSeconds = estimate({
              from: decodeCheckpoint(from).blockTimestamp,
              to: decodeCheckpoint(cursor).blockTimestamp,
              target: getEventsMaxBatchSize,
              result: events.length,
              min: 10,
              max: 86_400,
              prev: estimateSeconds,
              maxIncrease: 1.08,
            });

            consecutiveErrors = 0;
            yield { events, checkpoint: to };
            from = cursor;
          } catch (error) {
            // Handle errors by reducing the requested range by 10x
            estimateSeconds = Math.max(10, Math.round(estimateSeconds / 10));

            args.common.logger.debug({
              service: "sync",
              msg: `Failed to fetch events from the database, retrying with a ${formatEta(estimateSeconds * 1000)} range`,
            });

            if (++consecutiveErrors > 4) throw error;
          }
        }
      }

      /** `true` if all networks have synced all known finalized blocks.  */
      const allHistoricalSyncExhaustive = Array.from(
        perNetworkSync.values(),
      ).every(({ syncProgress }) => {
        if (isSyncEnd(syncProgress)) return true;

        // Determine if `finalized` block is considered "stale"
        const staleSeconds = (Date.now() - latestFinalizedFetch) / 1_000;
        if (staleSeconds <= args.common.options.syncHandoffStaleSeconds) {
          return true;
        }

        return false;
      });

      if (allHistoricalSyncExhaustive) break;

      /** At least one network has a `finalized` block that is considered "stale". */

      latestFinalizedFetch = Date.now();

      await Promise.all(
        Array.from(perNetworkSync.entries()).map(
          async ([network, { requestQueue, syncProgress }]) => {
            args.common.logger.debug({
              service: "sync",
              msg: `Refetching '${network.name}' finalized block`,
            });

            const latestBlock = await _eth_getBlockByNumber(requestQueue, {
              blockTag: "latest",
            });

            const finalizedBlockNumber = Math.max(
              0,
              hexToNumber(latestBlock.number) - network.finalityBlockCount,
            );

            syncProgress.finalized = await _eth_getBlockByNumber(requestQueue, {
              blockNumber: finalizedBlockNumber,
            });

            const historicalLast = getHistoricalLast(syncProgress);

            // Set metric "ponder_historical_total_blocks"
            args.common.metrics.ponder_historical_total_blocks.set(
              { network: network.name },
              hexToNumber(historicalLast.number) -
                hexToNumber(syncProgress.start.number) +
                1,
            );
          },
        ),
      );
    }
  }

  /**
   * Omnichain `onRealtimeSyncEvent`
   *
   * Handle callback events across all `args.networks`, and raising these
   * events to `args.onRealtimeEvent` while maintaining checkpoint ordering.
   */
  const onRealtimeSyncEvent = async ({
    network,
    event,
  }: { network: Network; event: RealtimeSyncEvent }) => {
    const { syncProgress, realtimeSync, unfinalizedBlocks } =
      perNetworkSync.get(network)!;

    switch (event.type) {
      /**
       * Handle a new block being ingested.
       */
      case "block": {
        // Update local sync, record checkpoint before and after
        const from = getOmnichainCheckpoint("current")!;
        syncProgress.current = event.block;
        const to = getOmnichainCheckpoint("current")!;

        // Update "ponder_sync_block" metric
        args.common.metrics.ponder_sync_block.set(
          { network: network.name },
          hexToNumber(syncProgress.current.number),
        );

        const newEvents = buildEvents({
          sources: args.indexingBuild.sources,
          chainId: network.chainId,
          blockWithEventData: event,
          finalizedChildAddresses: realtimeSync.finalizedChildAddresses,
          unfinalizedChildAddresses: realtimeSync.unfinalizedChildAddresses,
        });

        unfinalizedBlocks.push(event);
        pendingEvents.push(...newEvents);

        if (to > from) {
          for (const network of args.indexingBuild.networks) {
            updateRealtimeStatus({ checkpoint: to, network });
          }

          // Move events from pending to executed

          const events = pendingEvents
            .filter((event) => event.checkpoint < to)
            .sort((a, b) => (a.checkpoint < b.checkpoint ? -1 : 1));

          pendingEvents = pendingEvents.filter(
            ({ checkpoint }) => checkpoint > to,
          );
          executedEvents.push(...events);

          args
            .onRealtimeEvent({
              type: "block",
              checkpoint: to,
              status: structuredClone(status),
              events,
            })
            .then(() => {
              if (events.length > 0 && isKilled === false) {
                args.common.logger.info({
                  service: "app",
                  msg: `Indexed ${events.length} events`,
                });
              }

              // update `ponder_realtime_latency` metric
              for (const network of args.indexingBuild.networks) {
                for (const { block, endClock } of perNetworkSync.get(network)!
                  .unfinalizedBlocks) {
                  const checkpoint = encodeCheckpoint(
                    blockToCheckpoint(block, network.chainId, "up"),
                  );
                  if (checkpoint > from && checkpoint <= to && endClock) {
                    args.common.metrics.ponder_realtime_latency.observe(
                      { network: network.name },
                      endClock(),
                    );
                  }
                }
              }
            });
        }

        break;
      }
      /**
       * Handle a new block being finalized.
       */
      case "finalize": {
        // Newly finalized range
        const interval = [
          hexToNumber(syncProgress.finalized.number),
          hexToNumber(event.block.number),
        ] satisfies Interval;

        // Update local sync, record checkpoint before and after
        const prev = getOmnichainCheckpoint("finalized")!;
        syncProgress.finalized = event.block;
        const checkpoint = getOmnichainCheckpoint("finalized")!;

        if (
          getChainCheckpoint({ syncProgress, network, tag: "finalized" })! >
          getOmnichainCheckpoint("current")!
        ) {
          args.common.logger.warn({
            service: "sync",
            msg: `Finalized block for '${network.name}' has surpassed overall indexing checkpoint`,
          });
        }

        // Remove all finalized data

        const finalizedBlocks = unfinalizedBlocks.filter(
          ({ block }) =>
            hexToNumber(block.number) <= hexToNumber(event.block.number),
        );

        perNetworkSync.get(network)!.unfinalizedBlocks =
          unfinalizedBlocks.filter(
            ({ block }) =>
              hexToNumber(block.number) > hexToNumber(event.block.number),
          );

        executedEvents = executedEvents.filter(
          (e) => e.checkpoint > checkpoint,
        );

        // Add finalized blocks, logs, transactions, receipts, and traces to the sync-store.

        await Promise.all([
          args.syncStore.insertBlocks({
            blocks: finalizedBlocks
              .filter(({ hasMatchedFilter }) => hasMatchedFilter)
              .map(({ block }) => block),
            chainId: network.chainId,
          }),
          args.syncStore.insertLogs({
            logs: finalizedBlocks.flatMap(({ logs, block }) =>
              logs.map((log) => ({ log, block })),
            ),
            shouldUpdateCheckpoint: true,
            chainId: network.chainId,
          }),
          args.syncStore.insertLogs({
            logs: finalizedBlocks.flatMap(({ factoryLogs }) =>
              factoryLogs.map((log) => ({ log })),
            ),
            shouldUpdateCheckpoint: false,
            chainId: network.chainId,
          }),
          args.syncStore.insertTransactions({
            transactions: finalizedBlocks.flatMap(({ transactions, block }) =>
              transactions.map((transaction) => ({
                transaction,
                block,
              })),
            ),
            chainId: network.chainId,
          }),
          args.syncStore.insertTransactionReceipts({
            transactionReceipts: finalizedBlocks.flatMap(
              ({ transactionReceipts }) => transactionReceipts,
            ),
            chainId: network.chainId,
          }),
          args.syncStore.insertTraces({
            traces: finalizedBlocks.flatMap(({ traces, block, transactions }) =>
              traces.map((trace) => ({
                trace,
                block,
                transaction: transactions.find(
                  (t) => t.hash === trace.transactionHash,
                )!,
              })),
            ),
            chainId: network.chainId,
          }),
        ]);

        // Add corresponding intervals to the sync-store
        // Note: this should happen after so the database doesn't become corrupted

        if (network.disableCache === false) {
          await args.syncStore.insertIntervals({
            intervals: args.indexingBuild.sources
              .filter(({ filter }) => filter.chainId === network.chainId)
              .map(({ filter }) => ({ filter, interval })),
            chainId: network.chainId,
          });
        }

        // Raise event to parent function (runtime)
        if (checkpoint > prev) {
          args.onRealtimeEvent({ type: "finalize", checkpoint });
        }

        /**
         * The realtime service can be killed if `endBlock` is
         * defined has become finalized.
         */
        if (isSyncEnd(syncProgress)) {
          args.common.metrics.ponder_sync_is_realtime.set(
            { network: network.name },
            0,
          );
          args.common.metrics.ponder_sync_is_complete.set(
            { network: network.name },
            1,
          );
          args.common.logger.info({
            service: "sync",
            msg: `Synced final end block for '${network.name}' (${hexToNumber(syncProgress.end!.number)}), killing realtime sync service`,
          });
          realtimeSync.kill();
        }
        break;
      }
      /**
       * Handle a reorg with a new common ancestor block being found.
       */
      case "reorg": {
        syncProgress.current = event.block;
        // Note: this checkpoint is <= the previous checkpoint
        const checkpoint = getOmnichainCheckpoint("current")!;

        // Update "ponder_sync_block" metric
        args.common.metrics.ponder_sync_block.set(
          { network: network.name },
          hexToNumber(syncProgress.current.number),
        );

        // Remove all reorged data

        perNetworkSync.get(network)!.unfinalizedBlocks =
          unfinalizedBlocks.filter(
            ({ block }) =>
              hexToNumber(block.number) <= hexToNumber(event.block.number),
          );

        const isReorgedEvent = ({ chainId, block }: RawEvent) =>
          chainId === network.chainId &&
          Number(block.number) > hexToNumber(event.block.number);

        pendingEvents = pendingEvents.filter(
          (e) => isReorgedEvent(e) === false,
        );
        executedEvents = executedEvents.filter(
          (e) => isReorgedEvent(e) === false,
        );

        // Move events from executed to pending

        const events = executedEvents.filter((e) => e.checkpoint > checkpoint);
        executedEvents = executedEvents.filter(
          (e) => e.checkpoint < checkpoint,
        );
        pendingEvents.push(...events);

        await args.syncStore.pruneRpcRequestResult({
          chainId: network.chainId,
          blocks: event.reorgedBlocks,
        });

        // Raise event to parent function (runtime)
        args.onRealtimeEvent({ type: "reorg", checkpoint });

        break;
      }

      default:
        never(event);
    }
  };
  return {
    getEvents,
    async startRealtime() {
      for (const network of args.indexingBuild.networks) {
        const { syncProgress, realtimeSync } = perNetworkSync.get(network)!;

        const filters = args.indexingBuild.sources
          .filter(({ filter }) => filter.chainId === network.chainId)
          .map(({ filter }) => filter);

        status[network.name]!.block = {
          number: hexToNumber(syncProgress.current!.number),
          timestamp: hexToNumber(syncProgress.current!.timestamp),
        };
        status[network.name]!.ready = true;

        // Fetch any events between the omnichain finalized checkpoint and the single-chain
        // finalized checkpoint and add them to pendingEvents. These events are synced during
        // the historical phase, but must be indexed in the realtime phase because events
        // synced in realtime on other chains might be ordered before them.
        const from = getOmnichainCheckpoint("finalized")!;

        const finalized = getChainCheckpoint({
          syncProgress,
          network,
          tag: "finalized",
        })!;
        const end = getChainCheckpoint({
          syncProgress,
          network,
          tag: "end",
        })!;
        const to = min(finalized, end);

        if (to > from) {
          const events = await args.syncStore.getEvents({ filters, from, to });
          pendingEvents.push(...events.events);
        }

        if (isSyncEnd(syncProgress)) {
          args.common.metrics.ponder_sync_is_complete.set(
            { network: network.name },
            1,
          );
        } else {
          args.common.metrics.ponder_sync_is_realtime.set(
            { network: network.name },
            1,
          );

          const initialChildAddresses = new Map<Factory, Set<Address>>();

          for (const filter of filters) {
            if ("address" in filter && isAddressFactory(filter.address)) {
              const addresses = await args.syncStore.getChildAddresses({
                filter: filter.address,
              });

              initialChildAddresses.set(filter.address, new Set(addresses));
            }
          }

          realtimeSync.start({ syncProgress, initialChildAddresses });
        }
      }
    },
    getStartCheckpoint() {
      return getOmnichainCheckpoint("start")!;
    },
    getFinalizedCheckpoint() {
      return getOmnichainCheckpoint("finalized")!;
    },
    getStatus() {
      return status;
    },
    getCachedTransport(network) {
      const { requestQueue } = perNetworkSync.get(network)!;
      return cachedTransport({ requestQueue, syncStore: args.syncStore });
    },
    async kill() {
      isKilled = true;
      const promises: Promise<void>[] = [];
      for (const network of args.indexingBuild.networks) {
        const { historicalSync, realtimeSync, realtimeQueue } =
          perNetworkSync.get(network)!;
        historicalSync.kill();
        realtimeQueue.pause();
        realtimeQueue.clear();
        promises.push(realtimeQueue.onIdle());
        promises.push(realtimeSync.kill());
      }
      await Promise.all(promises);
    },
  };
};

/** ... */
export const syncDiagnostic = async ({
  common,
  sources,
  network,
  requestQueue,
}: {
  common: Common;
  sources: Source[];
  network: Network;
  requestQueue: RequestQueue;
}) => {
  /** Earliest `startBlock` among all `filters` */
  const start = Math.min(...sources.map(({ filter }) => filter.fromBlock ?? 0));
  /**
   * Latest `endBlock` among all filters. `undefined` if at least one
   * of the filters doesn't have an `endBlock`.
   */
  const end = sources.some(({ filter }) => filter.toBlock === undefined)
    ? undefined
    : Math.max(...sources.map(({ filter }) => filter.toBlock!));

  const [remoteChainId, startBlock, latestBlock] = await Promise.all([
    requestQueue.request({ method: "eth_chainId" }),
    _eth_getBlockByNumber(requestQueue, { blockNumber: start }),
    _eth_getBlockByNumber(requestQueue, { blockTag: "latest" }),
  ]);

  const endBlock =
    end === undefined
      ? undefined
      : end > hexToBigInt(latestBlock.number)
        ? ({
            number: toHex(end),
            hash: "0x",
            parentHash: "0x",
            timestamp: toHex(maxCheckpoint.blockTimestamp),
          } as LightBlock)
        : await _eth_getBlockByNumber(requestQueue, { blockNumber: end });

  // Warn if the config has a different chainId than the remote.
  if (hexToNumber(remoteChainId) !== network.chainId) {
    common.logger.warn({
      service: "sync",
      msg: `Remote chain ID (${remoteChainId}) does not match configured chain ID (${network.chainId}) for network "${network.name}"`,
    });
  }

  const finalizedBlockNumber = Math.max(
    0,
    hexToNumber(latestBlock.number) - network.finalityBlockCount,
  );

  const finalizedBlock = await _eth_getBlockByNumber(requestQueue, {
    blockNumber: finalizedBlockNumber,
  });

  return {
    start: startBlock,
    end: endBlock,
    finalized: finalizedBlock,
  };
};

/** Returns the closest-to-tip block that has been synced for all `sources`. */
export const getCachedBlock = ({
  sources,
  requestQueue,
  historicalSync,
}: {
  sources: Source[];
  requestQueue: RequestQueue;
  historicalSync: HistoricalSync;
}): Promise<SyncBlock | LightBlock> | undefined => {
  const latestCompletedBlocks = sources.map(({ filter }) => {
    const requiredInterval = [
      filter.fromBlock ?? 0,
      filter.toBlock ?? Number.POSITIVE_INFINITY,
    ] satisfies Interval;
    const fragmentIntervals = historicalSync.intervalsCache.get(filter)!;

    const completedIntervals = sortIntervals(
      intervalIntersection(
        [requiredInterval],
        intervalIntersectionMany(
          fragmentIntervals.map(({ intervals }) => intervals),
        ),
      ),
    );

    if (completedIntervals.length === 0) return undefined;

    const earliestCompletedInterval = completedIntervals[0]!;
    if (earliestCompletedInterval[0] !== (filter.fromBlock ?? 0)) {
      return undefined;
    }
    return earliestCompletedInterval[1];
  });

  const minCompletedBlock = Math.min(
    ...(latestCompletedBlocks.filter(
      (block) => block !== undefined,
    ) as number[]),
  );

  /**  Filter i has known progress if a completed interval is found or if
   * `_latestCompletedBlocks[i]` is undefined but `sources[i].filter.fromBlock`
   * is > `_minCompletedBlock`.
   */
  if (
    latestCompletedBlocks.every(
      (block, i) =>
        block !== undefined ||
        (sources[i]!.filter.fromBlock ?? 0) > minCompletedBlock,
    )
  ) {
    return _eth_getBlockByNumber(requestQueue, {
      blockNumber: minCompletedBlock,
    });
  }

  return undefined;
};

/** Predictive pagination and metrics for `historicalSync.sync()` */
export async function* localHistoricalSyncGenerator({
  common,
  network,
  syncProgress,
  historicalSync,
  showLogs,
}: {
  common: Common;
  network: Network;
  syncProgress: SyncProgress;
  historicalSync: HistoricalSync;
  showLogs: boolean;
}): AsyncGenerator {
  // Return immediately if the `syncProgress.start` is unfinalized
  if (
    hexToNumber(syncProgress.start.number) >
    hexToNumber(syncProgress.finalized.number)
  ) {
    syncProgress.current = syncProgress.finalized;

    // Update "ponder_sync_block" metric
    common.metrics.ponder_sync_block.set(
      { network: network.name },
      hexToNumber(syncProgress.current.number),
    );

    if (showLogs) {
      common.logger.warn({
        service: "historical",
        msg: `Skipped historical sync for '${network.name}' because the start block is not finalized`,
      });
    }

    const label = { network: network.name };
    // Set "ponder_historical_total_blocks"
    common.metrics.ponder_historical_total_blocks.set(label, 0);
    // Set "ponder_historical_sync_cached_blocks"
    common.metrics.ponder_historical_cached_blocks.set(label, 0);

    return;
  }

  const historicalLast = getHistoricalLast(syncProgress);

  // Intialize metrics

  const totalInterval = [
    hexToNumber(syncProgress.start.number),
    hexToNumber(historicalLast.number),
  ] satisfies Interval;

  const requiredIntervals = Array.from(
    historicalSync.intervalsCache.entries(),
  ).flatMap(([filter, fragmentIntervals]) =>
    intervalDifference(
      [
        [
          filter.fromBlock ?? 0,
          Math.min(
            filter.toBlock ?? Number.POSITIVE_INFINITY,
            totalInterval[1],
          ),
        ],
      ],
      intervalIntersectionMany(
        fragmentIntervals.map(({ intervals }) => intervals),
      ),
    ),
  );

  const required = intervalSum(intervalUnion(requiredIntervals));

  const total = totalInterval[1] - totalInterval[0] + 1;

  const label = { network: network.name };
  // Set "ponder_historical_total_blocks"
  common.metrics.ponder_historical_total_blocks.set(label, total);
  // Set "ponder_historical_sync_cached_blocks"
  common.metrics.ponder_historical_cached_blocks.set(label, total - required);

  if (showLogs) {
    common.logger.info({
      service: "historical",
      msg: `Started syncing '${network.name}' with ${formatPercentage(
        (total - required) / total,
      )} cached`,
    });
  }

  /**
   * Estimate optimal range (blocks) to sync at a time, eventually to be used to
   * determine `interval` passed to `historicalSync.sync()`.
   */
  let estimateRange = 25;
  // Cursor to track progress.
  let fromBlock = hexToNumber(syncProgress.start.number);

  /**
   * Handle a cache hit by fast forwarding and potentially exiting.
   * A cache hit can either be: (listed by priority)
   *   1) recovering progress from earlier invocations with different `finalized` blocks
   *   2) recovering progress from the interval cache
   */
  if (
    syncProgress.current !== undefined &&
    (syncProgress.cached === undefined ||
      hexToNumber(syncProgress.current.number) >
        hexToNumber(syncProgress.cached.number))
  ) {
    fromBlock = hexToNumber(syncProgress.current.number) + 1;
  } else if (syncProgress.cached !== undefined) {
    // `getEvents` can make progress without calling `sync`, so immediately "yield"
    yield;

    if (
      hexToNumber(syncProgress.cached.number) ===
      hexToNumber(historicalLast.number)
    ) {
      if (showLogs) {
        common.logger.info({
          service: "historical",
          msg: `Skipped historical sync for '${network.name}' because all blocks are cached.`,
        });
      }
      return;
    }

    fromBlock = hexToNumber(syncProgress.cached.number) + 1;
  }

  while (true) {
    /**
     * Select a range of blocks to sync bounded by `finalizedBlock`.
     *
     * It is important for devEx that the interval is not too large, because
     * time spent syncing ≈ time before indexing function feedback.
     */
    const interval: Interval = [
      Math.min(fromBlock, hexToNumber(historicalLast.number)),
      Math.min(fromBlock + estimateRange, hexToNumber(historicalLast.number)),
    ];

    const endClock = startClock();

    const syncBlock = await historicalSync.sync(interval);

    // Update cursor to record progress
    fromBlock = interval[1] + 1;

    if (syncBlock === undefined) {
      /**
       * `syncBlock` will be undefined if a cache hit occur in `historicalSync.sync()`.
       * If the all known blocks are synced, then update `syncProgress.current`, else
       * progress to the next iteration.
       */
      if (interval[1] === hexToNumber(historicalLast.number)) {
        syncProgress.current = historicalLast;
      } else {
        continue;
      }
    } else {
      if (interval[1] === hexToNumber(historicalLast.number)) {
        syncProgress.current = historicalLast;
      } else {
        syncProgress.current = syncBlock;
      }

      const duration = endClock();

      // Update "ponder_sync_block" metric
      common.metrics.ponder_sync_block.set(
        label,
        hexToNumber(syncProgress.current.number),
      );

      common.metrics.ponder_historical_duration.observe(label, duration);
      common.metrics.ponder_historical_completed_blocks.inc(
        label,
        interval[1] - interval[0] + 1,
      );

      // Use the duration and interval of the last call to `sync` to update estimate
      // 25 <= estimate(new) <= estimate(prev) * 2 <= 100_000
      estimateRange = Math.min(
        Math.max(
          25,
          Math.round((1_000 * (interval[1] - interval[0])) / duration),
        ),
        estimateRange * 2,
        100_000,
      );
    }

    yield;

    if (isSyncEnd(syncProgress) || isSyncFinalized(syncProgress)) {
      return;
    }
  }
}
