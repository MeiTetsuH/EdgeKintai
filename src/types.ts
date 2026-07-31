export type WorkType = 'office' | 'remote' | 'paid_leave' | 'holiday' | 'absent';
export type TransportTripType = 'one_way' | 'round_trip';

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: number;
  created_at: string;
  default_one_way_fare: number | null;
  default_trip_type: TransportTripType;
  default_clock_in: string | null;
  default_clock_out: string | null;
}

export interface Attendance {
  id: number;
  user_id: number;
  work_date: string;
  work_type: WorkType;
  clock_in: string | null;
  clock_out: string | null;
  break_minutes: number;
  transport_fee: number;
  transport_one_way_fee: number | null;
  transport_trip_type: TransportTripType;
  memo: string;
  created_at: string;
  updated_at: string;
}

export interface Holiday {
  date_str: string;
  name_ja: string;
}

export type HolidayDataSource = 'cache' | 'official-csv' | 'bundled-official' | 'unavailable';

export interface HolidayData {
  year: number;
  holidays: Holiday[];
  source: HolidayDataSource;
  complete: boolean;
  synced_at: string | null;
}

export interface AttendanceWithDay extends Attendance {
  day_of_week: number;
  is_holiday: boolean;
  holiday_name: string | null;
  work_minutes: number | null;
}

export interface MonthlySummary {
  year: number;
  month: number;
  username: string;
  employee_name: string;
  office_days: number;
  remote_days: number;
  paid_leave_days: number;
  absent_days: number;
  scheduled_work_days: number;
  incomplete_days: number;
  total_work_minutes: number;
  total_transport_fee: number;
  overtime_minutes: number;
  overtime_threshold_minutes: number;
  records: AttendanceWithDay[];
  holiday_data: Omit<HolidayData, 'holidays'>;
}

export interface PublicAppConfig {
  timezone: string;
  default_break_minutes: number;
  default_one_way_fare: number;
  default_trip_type: TransportTripType;
  default_clock_in: string | null;
  default_clock_out: string | null;
  overtime_threshold_hours: number;
}
