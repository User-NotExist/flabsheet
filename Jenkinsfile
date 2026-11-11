// Flabsheet: build and deploy the production stack (compose.prod.yaml) with
// Docker Compose on the Jenkins agent that runs it.
//
// Agent: any node (agent any) on the app server, with Docker
// Engine and the Compose v2 plugin, whose Jenkins user is in the docker group.
// The stack runs on that node's Docker daemon, so data volumes (pg-data,
// redis-data, rustfs-data) persist between builds under the "flabsheet"
// project name.
//
// Credentials (kind "Secret file"), filled from the matching *.example files:
//   flabsheet-root-env       -> .env          (infra passwords, ports, subnet)
//   flabsheet-backend-env    -> backend/.env  (baked into the backend image)
//   flabsheet-frontend-env   -> frontend/.env (baked into the frontend image)
//
// Deploys run for the main branch (multibranch job), for a plain Pipeline job
// (no BRANCH_NAME), or for any branch with FORCE_DEPLOY. Other branches only
// validate and build. Images are tagged with the short commit, and if the
// smoke test fails the previous tag is brought back up.
//
// The judge-worker-go submodule is not needed (compose.prod.yaml doesn't use
// it), so leave "recursive submodules" off in the job's SCM settings.
//
// The .env files are deleted from the workspace after every build. To manage
// the stack by hand, use the project name (no compose file or .env needed):
//   docker compose -p flabsheet ps
//   docker compose -p flabsheet exec backend python cli.py seed-admin   # first admin, once

pipeline {
    agent any

    options {
        // Two deploys at once would race on the same containers
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timeout(time: 45, unit: 'MINUTES')
    }

    parameters {
        booleanParam(name: 'FORCE_DEPLOY', defaultValue: false,
            description: 'Deploy even though this branch is not main')
        booleanParam(name: 'NO_CACHE', defaultValue: false,
            description: 'Rebuild images without the Docker layer cache')
    }

    environment {
        COMPOSE_FILE = 'compose.prod.yaml'
        // Host ports of the production stack. Shell variables beat the root
        // .env during compose interpolation, so these win over the credential's
        // FRONTEND_PORT/BACKEND_PORT. Inside the containers it stays 3000/8000.
        FRONTEND_PORT = '3005'
        BACKEND_PORT = '8005'
        // Image tags kept per image after a deploy, the running one included
        KEEP_IMAGE_TAGS = '3'
    }

    stages {
        stage('Prepare') {
            steps {
                script {
                    env.IMAGE_TAG = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim()
                    env.SHOULD_DEPLOY = (env.BRANCH_NAME == null || env.BRANCH_NAME == 'main' || params.FORCE_DEPLOY) ? 'true' : 'false'
                    currentBuild.description = "${env.IMAGE_TAG}${env.SHOULD_DEPLOY == 'true' ? '' : ' (build only)'}"
                }
                // Single-quoted so Groovy never interpolates the secret paths
                // into the command line (they would show up in the build log).
                withCredentials([
                    file(credentialsId: 'flabsheet-root-env', variable: 'ROOT_ENV'),
                    file(credentialsId: 'flabsheet-backend-env', variable: 'BACKEND_ENV'),
                    file(credentialsId: 'flabsheet-frontend-env', variable: 'FRONTEND_ENV'),
                ]) {
                    sh '''
                        set -eu
                        umask 077
                        cp "$ROOT_ENV" .env
                        cp "$BACKEND_ENV" backend/.env
                        cp "$FRONTEND_ENV" frontend/.env
                    '''
                }
                sh '''
                    set -eu
                    docker version --format 'docker {{.Server.Version}}'
                    docker compose version
                    # Fails on a missing required variable (the :? defaults) before building.
                    # --quiet keeps the resolved config, secrets included, out of the log.
                    docker compose config --quiet
                '''
            }
        }

        stage('Build') {
            steps {
                sh "docker compose build --pull ${params.NO_CACHE ? '--no-cache' : ''} backend worker frontend"
            }
        }

        stage('Deploy') {
            when { environment name: 'SHOULD_DEPLOY', value: 'true' }
            steps {
                script {
                    // Tag of the running backend, for rollback. Empty on the first deploy.
                    env.PREVIOUS_TAG = sh(returnStdout: true, script: '''
                        id=$(docker compose ps --quiet backend 2>/dev/null || true)
                        [ -n "$id" ] && docker inspect --format '{{.Config.Image}}' "$id" | sed 's/^.*://' || true
                    ''').trim()
                    echo "Previous tag: ${env.PREVIOUS_TAG ?: '(none)'} -> new tag: ${env.IMAGE_TAG}"
                }
                // storage-init is a one-shot job, which --wait would treat as a
                // failure once it exits, so it runs on its own (as in CI).
                sh '''
                    set -eu
                    docker compose up --detach --no-build --remove-orphans \
                        --wait --wait-timeout 240 \
                        postgres redis rustfs backend worker frontend
                    docker compose run --rm storage-init
                '''
            }
        }

        stage('Smoke test') {
            when { environment name: 'SHOULD_DEPLOY', value: 'true' }
            steps {
                // Probed from inside the containers, so it works whatever
                // APP_BIND_ADDR and the ports are set to.
                sh '''
                    set -eu
                    docker compose exec -T backend python -c \
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5)"
                    # /login renders without a session and goes through src/proxy.ts,
                    # which calls the backend over the stack network.
                    docker compose exec -T frontend node -e \
                        "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
                    # The worker has no healthcheck; make sure it did not crash-loop.
                    test "$(docker compose ps --format '{{.State}}' worker)" = running
                    docker compose ps
                '''
            }
            post {
                failure {
                    script {
                        dumpLogs()
                        env.LOGS_DUMPED = 'true'
                        if (env.PREVIOUS_TAG && env.PREVIOUS_TAG != env.IMAGE_TAG) {
                            echo "Smoke test failed, rolling back to ${env.PREVIOUS_TAG}"
                            // Uses the current checkout's compose file with the old
                            // images; fine unless the compose file itself broke things.
                            withEnv(["IMAGE_TAG=${env.PREVIOUS_TAG}"]) {
                                sh '''
                                    docker compose up --detach --no-build --remove-orphans \
                                        --wait --wait-timeout 240 backend worker frontend
                                '''
                            }
                        } else {
                            echo 'No previous deploy to roll back to'
                        }
                    }
                }
            }
        }

        stage('Clean up images') {
            when { environment name: 'SHOULD_DEPLOY', value: 'true' }
            steps {
                // Keep the newest KEEP_IMAGE_TAGS tags of each image (always
                // including the running one) so a manual rollback stays possible.
                sh '''
                    set -eu
                    for repo in flabsheet-backend flabsheet-frontend; do
                        docker image ls "$repo" --format '{{.Tag}}' \
                            | grep -v -x -e "$IMAGE_TAG" -e latest -e '<none>' \
                            | tail -n +"$KEEP_IMAGE_TAGS" \
                            | while read -r tag; do docker image rm "$repo:$tag" || true; done
                    done
                    docker image prune --force
                '''
            }
        }
    }

    post {
        failure {
            script {
                // A failed smoke test already dumped them, before rolling back
                if (env.LOGS_DUMPED != 'true') {
                    dumpLogs()
                }
            }
        }
        always {
            // The images and the running stack already have the settings;
            // don't leave secrets lying around in the workspace.
            sh 'rm -f .env backend/.env frontend/.env'
        }
    }
}

def dumpLogs() {
    sh '''
        docker compose ps --all || true
        docker compose logs --no-color --tail 200 backend worker frontend || true
    '''
}
