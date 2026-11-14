## CI Delta Report

Risk: High

#### Job rules match more broadly

File: `.gitlab-ci.yml`

Evidence:

- Job `deploy` `only:refs` now also matches `merge_requests`.

#### Job rules match more broadly

File: `.gitlab-ci.yml`

Evidence:

- Job `lint` `except:variables` no longer excludes `$FORK_PIPELINE`.
