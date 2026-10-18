-- Skip per-record deletion audits when their user is being deleted.
-- Keep normal attendance deletion audits and all existing data unchanged.
DROP TRIGGER attendance_audit_delete;

CREATE TRIGGER attendance_audit_delete
AFTER DELETE ON attendance
WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
BEGIN
  INSERT INTO audit_logs (
    actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
  ) VALUES (
    OLD.user_id,
    OLD.user_id,
    'attendance_delete',
    'attendance',
    OLD.work_date,
    json_object(
      'work_type', OLD.work_type,
      'clock_in', OLD.clock_in,
      'clock_out', OLD.clock_out,
      'break_minutes', OLD.break_minutes,
      'transport_fee', OLD.transport_fee,
      'transport_one_way_fee', OLD.transport_one_way_fee,
      'transport_trip_type', OLD.transport_trip_type,
      'transport_mode', OLD.transport_mode,
      'memo', OLD.memo
    ),
    NULL
  );
END;
