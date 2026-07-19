/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
} from './types';
import { Socket } from 'socket.io-client';
import { RpcResultLedger } from './RpcResultLedger';
import { z } from 'zod';
import { hashObject } from '@/utils/deterministicJson';

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly logger: (message: string, data?: any) => void;
    private readonly resultLedger: RpcResultLedger;
    private socket: Socket | null = null;

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
        this.resultLedger = config.resultLedger ?? new RpcResultLedger();
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);

        if (this.socket) {
            this.socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        if (!request
            || typeof request.method !== 'string'
            || request.method.length === 0
            || typeof request.params !== 'string') {
            return this.encryptError('Invalid RPC request');
        }
        let decryptedParams: unknown;
        try {
            // Decrypt exactly once. Stable call fingerprints use canonical
            // plaintext so a retry may legitimately carry a fresh nonce.
            decryptedParams = decrypt(
                this.encryptionKey,
                this.encryptionVariant,
                decodeBase64(request.params),
            );
        } catch (error) {
            return this.encryptError(error instanceof Error ? error.message : 'Invalid RPC params');
        }

        // Missing callId is the rolling-upgrade legacy path. It preserves the
        // old behavior but cannot provide durable at-most-once execution.
        if (request.callId === undefined) return this.executeHandler(request, decryptedParams);
        if (!z.string().uuid().safeParse(request.callId).success) {
            return this.encryptError('Invalid RPC callId');
        }

        const outcome = await this.resultLedger.execute(
            {
                callId: request.callId,
                method: request.method,
                paramsHash: hashObject(decryptedParams),
            },
            () => this.executeHandler(request, decryptedParams),
        );
        if (outcome.status === 'completed') return outcome.response;
        this.logger('[RPC] Refusing unsafe RPC execution', {
            callId: request.callId,
            method: request.method,
            status: outcome.status,
            reason: outcome.reason,
        });
        return this.encryptError(outcome.reason);
    }

    private async executeHandler(request: RpcRequest, decryptedParams: unknown): Promise<string> {
        try {
            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                return this.encryptError('Method not found');
            }

            // Call the handler
            this.logger('[RPC] Calling handler', { method: request.method });
            const result = await handler(decryptedParams);
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

            // Encrypt and return the response
            const encryptedResponse = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, result));
            this.logger('[RPC] Sending encrypted response', { method: request.method, responseLength: encryptedResponse.length });
            return encryptedResponse;
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request', {
                error: error instanceof Error
                    ? { name: error.name, message: error.message }
                    : { message: String(error) }
            });
            const errorResponse = {
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
        }
    }

    private encryptError(message: string): string {
        return encodeBase64(encrypt(
            this.encryptionKey,
            this.encryptionVariant,
            { error: message },
        ));
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket;
        for (const [prefixedMethod] of this.handlers) {
            socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    onSocketDisconnect(): void {
        this.socket = null;
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.logger('Cleared all RPC handlers');
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
