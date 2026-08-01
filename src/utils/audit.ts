const PRECISE_ROUTE_FIELDS = new Set([
  'default_transport_origin',
  'default_transport_destination',
  'transport_origin',
  'transport_destination',
]);

export function stringifyAuditJson(value: unknown): string {
  return JSON.stringify(value, (key, nestedValue) => (
    PRECISE_ROUTE_FIELDS.has(key) ? undefined : nestedValue
  ));
}
