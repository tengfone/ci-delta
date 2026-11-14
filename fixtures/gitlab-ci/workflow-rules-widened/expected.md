## CI Delta Report

Risk: High

#### Workflow rules match more broadly

File: `.gitlab-ci.yml`

Evidence:

- Workflow changed rule `if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` to `if: $CI_COMMIT_BRANCH`: `if:` relaxed `$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` to `$CI_COMMIT_BRANCH`, which matches any non-empty value.
