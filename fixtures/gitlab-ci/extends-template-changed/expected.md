## CI Delta Report

Risk: High

#### Job rules removed

File: `.gitlab-ci.yml`

Evidence:

- Job `release` removed its `rules` conditions. Previous conditions: `if: $CI_COMMIT_TAG`.

#### Job extends changed

File: `.gitlab-ci.yml`

Evidence:

- Job `release` extends changed from `.safe_release` to `.quick`.
- Other findings for this job compare the fully resolved configuration.
