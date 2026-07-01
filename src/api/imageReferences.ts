import { createHash } from 'node:crypto';
import type { UserMessage } from './types';

const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024;
const REMOTE_IMAGE_FETCH_TIMEOUT_MS = 30_000;
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

type UrlImageSource = {
    type: 'url';
    media_type: ImageMediaType;
    url: string;
    sha256?: string;
    size_bytes?: number;
    filename?: string;
    headers?: Record<string, string>;
};

type Base64ImageSource = {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
};

function assertFetchableImageUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Image reference URL is invalid');
    }
    if (parsed.protocol === 'https:') return parsed;
    if (parsed.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(parsed.hostname)) return parsed;
    throw new Error('Image reference URL must use HTTPS, except localhost development URLs');
}

function detectImageMediaType(bytes: Buffer): ImageMediaType | null {
    if (bytes.length >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (bytes.length >= 6) {
        const gifHeader = bytes.subarray(0, 6).toString('ascii');
        if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'image/gif';
    }
    if (bytes.length >= 12
        && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }
    return null;
}

async function fetchReferencedImage(source: UrlImageSource, index: number): Promise<Base64ImageSource> {
    if (!ALLOWED_IMAGE_MEDIA_TYPES.has(source.media_type)) {
        throw new Error(`Image reference ${index + 1} media type is unsupported`);
    }
    const parsedUrl = assertFetchableImageUrl(source.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_IMAGE_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(parsedUrl, {
            method: 'GET',
            headers: source.headers ?? {},
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`Image reference ${index + 1} download failed with HTTP ${response.status}`);
        }
        const declaredLength = response.headers.get('content-length');
        if (declaredLength && Number(declaredLength) > MAX_REMOTE_IMAGE_BYTES) {
            throw new Error(`Image reference ${index + 1} is too large`);
        }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType && contentType !== source.media_type) {
            throw new Error(`Image reference ${index + 1} content type does not match declared media type`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength === 0) {
            throw new Error(`Image reference ${index + 1} decoded to an empty file`);
        }
        if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) {
            throw new Error(`Image reference ${index + 1} is too large`);
        }
        if (typeof source.size_bytes === 'number' && bytes.byteLength !== source.size_bytes) {
            throw new Error(`Image reference ${index + 1} size mismatch`);
        }
        const detected = detectImageMediaType(bytes);
        if (!detected) {
            throw new Error(`Image reference ${index + 1} is not a supported image file`);
        }
        if (detected !== source.media_type) {
            throw new Error(`Image reference ${index + 1} file type does not match declared media type`);
        }
        if (source.sha256) {
            const actual = createHash('sha256').update(bytes).digest('hex');
            if (actual !== source.sha256) {
                throw new Error(`Image reference ${index + 1} checksum mismatch`);
            }
        }
        return {
            type: 'base64',
            media_type: source.media_type,
            data: bytes.toString('base64'),
        };
    } finally {
        clearTimeout(timer);
    }
}

export async function resolveUserMessageImageReferences(message: UserMessage): Promise<UserMessage> {
    if (message.content.type !== 'multipart') return message;

    let changed = false;
    const parts = [];
    for (let index = 0; index < message.content.parts.length; index += 1) {
        const part = message.content.parts[index];
        if (part.type !== 'image' || part.source.type !== 'url') {
            parts.push(part);
            continue;
        }
        changed = true;
        parts.push({
            type: 'image' as const,
            source: await fetchReferencedImage(part.source, index),
        });
    }
    if (!changed) return message;
    return {
        ...message,
        content: {
            type: 'multipart',
            parts,
        },
    };
}

export const __testImageReferenceInternals = {
    assertFetchableImageUrl,
    detectImageMediaType,
    fetchReferencedImage,
    MAX_REMOTE_IMAGE_BYTES,
};
