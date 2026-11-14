## CI Delta Report

Risk: High

#### Privileged service added

File: `.gitlab-ci.yml`

Evidence:

- Job `image-build` service `docker` uses `docker:27-dind`, which needs a privileged runner.

#### Service image changed

File: `.gitlab-ci.yml`

Evidence:

- Job `image-build` service `docker` image is now `docker:27-dind`.
