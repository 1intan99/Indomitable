import type { Client, ClientOptions as DiscordJsClientOptions } from 'discord.js';
import { WorkerShardingStrategy } from '@discordjs/ws';
import { Indomitable } from '../Indomitable';
import { ClientEvents, InternalEvents, LibraryEvents } from '../Util';
import { ConcurrencyClient } from '../concurrency/ConcurrencyClient.js';
import { ShardClientUtil } from './ShardClientUtil';

export interface PartialInternalEvents {
    op: ClientEvents,
    data: { clusterId: number, shardId?: number, replayed?: number, event?: CloseEvent, ipcId?: string }
}

export class ShardClient {
    public readonly manager: Indomitable;
    public readonly client: Client;
    public readonly clusterId: number;
    public constructor(manager: Indomitable) {
        this.manager = manager;
        // pseudo initialize shard client util to make the concurrency client work
        const shardClientUtil = new ShardClientUtil(manager);
        const concurrencyClient = new ConcurrencyClient(shardClientUtil);
        const clientOptions = manager.clientOptions as DiscordJsClientOptions || {};
        clientOptions.shards = shardClientUtil.shardIds;
        clientOptions.shardCount = shardClientUtil.shardCount;
        // a very kekw way of injecting custom options, due to backward compatibility,
        // d.js didn't provide a way to access the ws options of @discordjs/ws package
        if (manager.handleConcurrency) {
            if (!clientOptions.ws) clientOptions.ws = {};
            // default to worker sharding strategy if this is enabled, no choice due to lack of option in d.js
            clientOptions.ws.buildStrategy = websocketManager => {
                websocketManager.options.buildIdentifyThrottler = () => Promise.resolve(concurrencyClient);
                return new WorkerShardingStrategy(websocketManager, { shardsPerWorker: Math.floor(shardClientUtil.shardCount / 2) });
            };
        }
        const client = new manager.client(clientOptions);
        shardClientUtil.build(client);
        // @ts-ignore -- our own class
        client.shard = shardClientUtil;
        this.client = client;
        this.clusterId = Number(process.env.INDOMITABLE_CLUSTER);
    }

    public async start(token: string): Promise<void> {
        // attach listeners
        this.client.once('ready', () => this.send({ op: ClientEvents.READY, data: { clusterId: this.clusterId }}));
        this.client.on('shardReady', (shardId: number) => this.send({ op: ClientEvents.SHARD_READY, data: { clusterId: this.clusterId, shardId }}));
        this.client.on('shardReconnecting', (shardId: number) => this.send({ op: ClientEvents.SHARD_RECONNECT, data: { clusterId: this.clusterId, shardId }}));
        this.client.on('shardResume', (shardId: number, replayed: number) => this.send({ op: ClientEvents.SHARD_RESUME, data: { clusterId: this.clusterId, shardId, replayed }}));
        // @ts-ignore -- Discord.JS faulty typings?
        this.client.on('shardDisconnect', (event: CloseEvent, shardId: number) => this.send({ op: ClientEvents.SHARD_DISCONNECT, data: { clusterId: this.clusterId, shardId, event }}));
        await this.client.login(token);
    }

    private send(partial: PartialInternalEvents): void {
        // @ts-ignore -- our own class
        const shardClientUtil = this.client.shard as ShardClientUtil;
        const content: InternalEvents = { ...partial, internal: true };
        shardClientUtil
            .send({ content, repliable: false })
            .catch((error: unknown) => this.client.emit(LibraryEvents.ERROR, error as Error));
    }
}
