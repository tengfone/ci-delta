## CI Delta Report

Risk: High

#### External secret added

File: `.gitlab-ci.yml`

Evidence:

- Job `migrate` now reads secret `DATABASE_PASSWORD` from `vault: production/db/password@ops`.
