## CI Delta Report

Risk: High

#### Job rules match more broadly

File: `.gitlab-ci.yml`

Evidence:

- Job `publish` changed rule `if: $CI_COMMIT_BRANCH == "main"` to `if: $CI_COMMIT_BRANCH`: `if:` relaxed `$CI_COMMIT_BRANCH == "main"` to `$CI_COMMIT_BRANCH`, which matches any non-empty value.
