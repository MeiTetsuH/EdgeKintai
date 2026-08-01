import type { TransportMode, TransportTripType, WorkType } from '../types';
import { isValidDate, isValidTime } from './time';

export class RequestValidationError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

export async function readJsonObject(
  request: Request,
  maxBytes = 16_384,
): Promise<Record<string, unknown>> {
  const bytes = await readBodyBytes(request, maxBytes);

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestValidationError('JSON 格式不正确');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError('请求内容必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0) {
      throw new RequestValidationError('Content-Length 不正确');
    }
    if (length > maxBytes) {
      throw new RequestValidationError('请求内容过大', 413);
    }
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('body too large');
        throw new RequestValidationError('请求内容过大', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function requiredString(
  value: unknown,
  label: string,
  minLength: number,
  maxLength: number,
): string {
  if (typeof value !== 'string') throw new RequestValidationError(`${label}不能为空`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new RequestValidationError(`${label}长度必须为 ${minLength}-${maxLength} 个字符`);
  }
  if (/\p{Cc}/u.test(normalized)) throw new RequestValidationError(`${label}包含无效字符`);
  return normalized;
}

export function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RequestValidationError(`${label}格式不正确`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length > maxLength || /\p{Cc}/u.test(normalized)) {
    throw new RequestValidationError(`${label}最多 ${maxLength} 个字符`);
  }
  return normalized;
}

export function displayNameValue(value: unknown): string {
  const displayName = requiredString(value, '姓名', 1, 80);
  const visible = displayName.replace(/[\p{C}\p{Z}]/gu, '');
  if (!visible || !/[\p{L}\p{N}\p{M}\p{S}]/u.test(visible)) {
    throw new RequestValidationError('姓名必须包含可显示的文字');
  }
  return displayName;
}

export function usernameValue(value: unknown): string {
  const username = requiredString(value, '登录名', 3, 64);
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new RequestValidationError('登录名只能包含英文字母、数字、点、下划线和连字符');
  }
  return username;
}

export function passwordValue(value: unknown, label = '密码'): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new RequestValidationError(`${label}长度必须为 12-128 个字符`);
  }
  return value;
}

export function workTypeValue(value: unknown, fallback?: WorkType): WorkType {
  if (value === undefined && fallback) return fallback;
  if (value === 'office' || value === 'remote' || value === 'paid_leave' || value === 'holiday' || value === 'absent') {
    return value;
  }
  throw new RequestValidationError('勤務区分不正确');
}

export function tripTypeValue(value: unknown, fallback?: TransportTripType): TransportTripType {
  if (value === undefined && fallback) return fallback;
  if (value === 'one_way' || value === 'round_trip') return value;
  throw new RequestValidationError('交通费区分不正确');
}

export function transportModeValue(value: unknown, fallback?: TransportMode): TransportMode {
  if (value === undefined && fallback) return fallback;
  if (value === 'rail' || value === 'bus' || value === 'taxi' || value === 'other') return value;
  throw new RequestValidationError('交通手段不正确');
}

export function boundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RequestValidationError(`${label}必须是 ${min}-${max} 的整数`);
  }
  return value;
}

export function nullableBoundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return boundedInteger(value, label, min, max);
}

export function positiveIdValue(value: string): number {
  if (!/^\d+$/.test(value)) throw new RequestValidationError('ID 不正确');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new RequestValidationError('ID 不正确');
  return id;
}

export function nullableTime(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isValidTime(value)) {
    throw new RequestValidationError(`${label}必须是 HH:MM 格式`);
  }
  return value;
}

export function dateValue(value: string): string {
  if (!isValidDate(value)) throw new RequestValidationError('日期必须是有效的 YYYY-MM-DD');
  return value;
}

export function yearMonthValues(yearText: string, monthText: string): { year: number; month: number } {
  if (!/^\d{4}$/.test(yearText) || !/^(?:[1-9]|1[0-2])$/.test(monthText)) {
    throw new RequestValidationError('年月不正确');
  }
  const year = Number(yearText);
  const month = Number(monthText);
  if (year < 1955 || year > 2100) throw new RequestValidationError('年份必须在 1955-2100 之间');
  return { year, month };
}
