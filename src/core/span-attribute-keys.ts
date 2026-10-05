/** Attribute keys promoted to dedicated span columns — excluded from the free-form `attributes`. */
export const PROMOTED_SPAN_ATTR_KEYS: ReadonlySet<string> = new Set<string>([
  'http_method',
  'http_route',
  'http_status_code',
  'db_system',
  'db_operation',
  'db_table',
  'db_duration_ms',
  'db_duration_us',
  'trace_flags',
]);
