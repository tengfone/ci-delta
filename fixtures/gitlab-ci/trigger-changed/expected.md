## CI Delta Report

Risk: High

#### Downstream pipeline target changed

File: `.gitlab-ci.yml`

Evidence:

- Job `child` trigger changed from `include: local: ci/child.yml` to `include: local: ci/other-child.yml`.
- ci-delta does not analyze the downstream pipeline configuration.

#### Downstream pipeline no longer gates this pipeline

File: `.gitlab-ci.yml`

Evidence:

- Job `child` removed `strategy: depend`, so it succeeds as soon as the downstream pipeline is created.
