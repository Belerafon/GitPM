# P11D deterministic calculation report

Formula version: `equal-assignee-share/equal-person-working-day/v1`.

1. Each Task estimate is split equally between its active assignees.
2. Each person's share is split equally between that person's working dates in the inclusive Task range.
3. Daily shares are grouped by ISO week starting Monday.
4. Weekly capacity is `weekly_capacity_hours × available working weekdays / configured working weekdays`; holidays reduce available weekdays.

Fixture results:

| Person | ISO week | Allocation | Capacity | Utilization |
| --- | --- | ---: | ---: | ---: |
| Ada | 2026-07-06 | 32 h | 32 h | 100% |
| Ada | 2026-07-13 | 18 h | 40 h | 45% |
| Linus | 2026-07-06 | 20 h | 25.6 h | 78.125% |

The 2026-07-08 holiday reduces the first-week capacity from 40 to 32 hours for Ada and from 32 to 25.6 hours for Linus. One archived Task and one undated Task are excluded. The browser fixture reports no changed repository paths.
