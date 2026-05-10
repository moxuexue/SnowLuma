import type { SnowLumaApiClient } from '../client/api-client';
import type {
  JsonObject,
  OneBotMessageEvent,
  OutgoingMessage,
  RequestOptions,
  SnowLumaEvent,
} from '../types/index';

export type MaybePromise<T = void> = T | Promise<T>;
export type EventNext = () => Promise<void>;

/** Type guard or predicate used by client.when(). */
export type EventPredicate<TEvent extends SnowLumaEvent = SnowLumaEvent> = (event: SnowLumaEvent) => event is TEvent;

/** Handler for one narrowed SnowLuma event. */
export type EventHandler<TEvent extends SnowLumaEvent = SnowLumaEvent> = (
  event: TEvent,
  context: SnowLumaEventContext<TEvent>,
) => MaybePromise;

/** Middleware in the WebSocket event dispatch pipeline. */
export type EventMiddleware = (
  event: SnowLumaEvent,
  context: SnowLumaEventContext,
  next: EventNext,
) => MaybePromise;

/** Options for accepting or rejecting OneBot request events. */
export interface RequestDecisionOptions extends RequestOptions {
  reason?: string;
  subType?: string;
}

/** Convenience context passed to event middleware and handlers. */
export interface SnowLumaEventContext<TEvent extends SnowLumaEvent = SnowLumaEvent> {
  readonly event: TEvent;
  readonly client: SnowLumaApiClient;
  readonly stopped: boolean;
  /** Prevents subsequent middleware and final onEvent listeners from running. */
  stopPropagation(): void;
  /** Replies to private or group message events with the correct API. */
  reply(message: OutgoingMessage, options?: RequestOptions & { autoEscape?: boolean }): Promise<unknown>;
  /** Approves a friend or group request event. */
  approve(options?: RequestDecisionOptions): Promise<unknown>;
  /** Rejects a friend or group request event. */
  reject(reason?: string, options?: RequestDecisionOptions): Promise<unknown>;
  /** Sends OneBot .handle_quick_operation with the current event as context. */
  quickOperation(operation: JsonObject, options?: RequestOptions): Promise<unknown>;
}

/** Command matching options for WebSocketClient.command(). */
export interface CommandOptions {
  prefixes?: string | string[];
  trim?: boolean;
  caseSensitive?: boolean;
}

/** Parsed command information passed to command handlers. */
export interface CommandMatch {
  command: string;
  text: string;
  args: string[];
  rest: string;
  prefix: string;
  match: RegExpMatchArray | null;
}

export type CommandHandler<TEvent extends OneBotMessageEvent = OneBotMessageEvent> = (
  event: TEvent,
  context: SnowLumaEventContext<TEvent> & { command: CommandMatch },
  match: CommandMatch,
) => MaybePromise;
