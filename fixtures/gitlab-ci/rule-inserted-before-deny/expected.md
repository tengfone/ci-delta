## CI Delta Report

Risk: Medium

#### Job rules match more broadly

File: `.gitlab-ci.yml`

Evidence:

- Job `test` added rule `if: $CI_PIPELINE_SOURCE == "merge_request_event"` ahead of deny rule `if: $CI_PROJECT_NAMESPACE != "acme"; when: never`, which can run the job (`when: on_success`).
