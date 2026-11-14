## CI Delta Report

Risk: High

#### Manual approval gate removed

File: `.gitlab-ci.yml`

Evidence:

- Job `deploy_prod` was `when: manual` and is now `when: on_success`.
- The job deploys to environment `production`.
