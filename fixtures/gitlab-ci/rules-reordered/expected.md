## CI Delta Report

Risk: Medium

#### Job rules match more broadly

File: `.gitlab-ci.yml`

Evidence:

- Job `test` now evaluates `when: on_success` before the deny rule `if: $CI_PROJECT_NAMESPACE != "acme"; when: never`.
