import { requestUrl } from 'obsidian';
export { CLIP2MD_API_BASE_URL, CLIP2MD_APP_URL } from './config';
import { CLIP2MD_API_BASE_URL } from './config';

export interface DeviceBindingSession {
    device_code: string;
    user_code: string;
    expires_in: number;
    interval: number;
}

export interface DeviceLaunchLinkResponse {
    launch_url: string;
}

export type DeviceCredentialStatus =
    | { status: 'pending_approval'; retry_after: number }
    | { status: 'approving'; retry_after: number }
    | {
        status: 'approved';
        credential_id: number;
        credential_name: string;
        api_key: string;
    };

export class DeviceBindingError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly code: string,
    ) {
        super(message);
    }
}

function encodeBase64(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < view.length; offset += chunkSize) {
        binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
    }
    return window.btoa(binary);
}

function errorFromResponse(status: number, json: unknown): DeviceBindingError {
    const payload = json as { detail?: string | { code?: string; message?: string } } | null;
    const detail = payload?.detail;
    const code = typeof detail === 'object' && detail?.code
        ? detail.code
        : typeof detail === 'string' ? detail : 'binding_request_failed';
    const message = typeof detail === 'object' && detail?.message
        ? detail.message
        : typeof detail === 'string' ? detail : '绑定请求失败';
    return new DeviceBindingError(message, status, code);
}

export class DeviceBindingClient {
    async start(clientName: string): Promise<DeviceBindingSession> {
        const response = await requestUrl({
            url: `${CLIP2MD_API_BASE_URL}/auth/wechat/device/start`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ client_type: 'OBSIDIAN', client_name: clientName }),
            throw: false,
        });
        if (response.status < 200 || response.status >= 300) {
            throw errorFromResponse(response.status, response.json);
        }
        return response.json as DeviceBindingSession;
    }

    async qrcode(deviceCode: string): Promise<string> {
        const response = await requestUrl({
            url: `${CLIP2MD_API_BASE_URL}/auth/wechat/device/qrcode`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ device_code: deviceCode }),
            throw: false,
        });
        if (response.status < 200 || response.status >= 300) {
            throw errorFromResponse(response.status, response.json);
        }
        return `data:image/png;base64,${encodeBase64(response.arrayBuffer)}`;
    }

    async launchLink(deviceCode: string): Promise<string> {
        const response = await requestUrl({
            url: `${CLIP2MD_API_BASE_URL}/auth/wechat/device/launch-link`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ device_code: deviceCode }),
            throw: false,
        });
        if (response.status < 200 || response.status >= 300) {
            throw errorFromResponse(response.status, response.json);
        }
        const payload = response.json as DeviceLaunchLinkResponse;
        if (!payload?.launch_url) {
            throw new DeviceBindingError('绑定入口不可用', response.status, 'wechat_url_link_unavailable');
        }
        return payload.launch_url;
    }

    async credential(deviceCode: string): Promise<DeviceCredentialStatus> {
        const response = await requestUrl({
            url: `${CLIP2MD_API_BASE_URL}/auth/wechat/device/credential`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ device_code: deviceCode }),
            throw: false,
        });
        if (response.status < 200 || response.status >= 300) {
            throw errorFromResponse(response.status, response.json);
        }
        return response.json as DeviceCredentialStatus;
    }
}
