/**
 * Common RPC types and interfaces for both session and machine clients
 */

/**
 * Generic RPC handler function type
 * @template TRequest - The request data type
 * @template TResponse - The response data type
 */
export type RpcHandler<TRequest = any, TResponse = any> = (
    data: TRequest
) => TResponse | Promise<TResponse>;

/**
 * Map of method names to their handlers
 */
export type RpcHandlerMap = Map<string, RpcHandler>;

export interface RpcHandlerRegistrationOptions {
    /**
     * `durable` is the compatibility default and retains replayable results
     * for a bounded retry horizon. `durable-acknowledged` retains results
     * until the authoritative caller explicitly commits and acknowledges
     * them. `read-only` bypasses the side-effect ledger.
     */
    execution?: 'durable' | 'durable-acknowledged' | 'read-only';
}

/**
 * RPC request data from server
 */
export interface RpcRequest {
    callId?: string;
    method: string;
    params: string; // Base64 encoded encrypted params
}

/**
 * RPC response callback
 */
export type RpcResponseCallback = (response: string) => void;

/**
 * Configuration for RPC handler manager
 */
export interface RpcHandlerConfig {
    scopePrefix: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    logger?: (message: string, data?: any) => void;
    resultLedger?: import('./RpcResultLedger').RpcResultLedger;
}

/**
 * Result of RPC handler execution
 */
export type RpcHandlerResult<T = any> =
    | { success: true; data: T }
    | { success: false; error: string };
