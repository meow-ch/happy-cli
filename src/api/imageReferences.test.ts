import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveUserMessageImageReferences } from './imageReferences';
import type { UserMessage } from './types';

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
);

describe('image reference resolution', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('downloads URL image references and rewrites them to base64 image parts', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG_1X1, {
            status: 200,
            headers: {
                'content-type': 'image/png',
                'content-length': String(PNG_1X1.byteLength),
            },
        })));

        const message: UserMessage = {
            role: 'user',
            content: {
                type: 'multipart',
                parts: [
                    { type: 'text', text: 'look at this' },
                    {
                        type: 'image',
                        source: {
                            type: 'url',
                            url: 'https://plane.example.test/api/v1/artifacts/art_1/download?account_id=acc_1',
                            media_type: 'image/png',
                            size_bytes: PNG_1X1.byteLength,
                            sha256: '4b5c5c92cec3b23e6a294fc0eea43234ef5126c5a64f4c6c531ac8430ab0b844',
                        },
                    },
                ],
            },
        };

        const resolved = await resolveUserMessageImageReferences(message);

        expect(resolved.content.type).toBe('multipart');
        if (resolved.content.type !== 'multipart') throw new Error('expected multipart');
        expect(resolved.content.parts[1]).toEqual({
            type: 'image',
            source: {
                type: 'base64',
                media_type: 'image/png',
                data: PNG_1X1.toString('base64'),
            },
        });
    });

    it('rejects checksum mismatches before handing images to the agent adapter', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG_1X1, {
            status: 200,
            headers: { 'content-type': 'image/png' },
        })));

        const message: UserMessage = {
            role: 'user',
            content: {
                type: 'multipart',
                parts: [{
                    type: 'image',
                    source: {
                        type: 'url',
                        url: 'https://plane.example.test/api/v1/artifacts/art_1/download?account_id=acc_1',
                        media_type: 'image/png',
                        sha256: '0'.repeat(64),
                    },
                }],
            },
        };

        await expect(resolveUserMessageImageReferences(message)).rejects.toThrow(/checksum mismatch/);
    });

    it('rejects non-local HTTP image references', async () => {
        const message: UserMessage = {
            role: 'user',
            content: {
                type: 'multipart',
                parts: [{
                    type: 'image',
                    source: {
                        type: 'url',
                        url: 'http://plane.example.test/api/v1/artifacts/art_1/download?account_id=acc_1',
                        media_type: 'image/png',
                    },
                }],
            },
        };

        await expect(resolveUserMessageImageReferences(message)).rejects.toThrow(/must use HTTPS/);
    });
});
