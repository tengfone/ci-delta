## CI Delta Report

Risk: Medium

#### Job rules match more broadly

File: `.gitlab-ci.yml`

Evidence:

- Job `test` removed deny rule `if: $CI_PROJECT_NAMESPACE != "acme"; when: never`; pipelines it matched can now fall through to `when: always`.
