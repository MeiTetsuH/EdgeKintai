ALTER TABLE users ADD COLUMN default_clock_in TEXT
  CHECK (
    default_clock_in IS NULL OR (
      default_clock_in GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(default_clock_in, 1, 2) AS INTEGER) <= 23
    )
  );

ALTER TABLE users ADD COLUMN default_clock_out TEXT
  CHECK (
    default_clock_out IS NULL OR (
      default_clock_out GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(default_clock_out, 1, 2) AS INTEGER) <= 23
    )
  );
