.DEFAULT_GOAL := help

COMPOSE ?= docker compose

.PHONY: help up down logs test seed up-gpu compose-config

help:
	@printf '%s\n' \
		'make up             Start the development stack and wait until it is healthy' \
		'make down           Stop the development stack' \
		'make logs           Follow service logs' \
		'make test           Run the workspace test suite' \
		'make seed           Check Postgres and Redis, and create the development bucket' \
		'make up-gpu         Start the stack with the NVIDIA profile for the AI worker' \
		'make compose-config Validate the default Compose file and the gpu profile'

up:
	./infra/seaweedfs/start-storage.sh
	$(COMPOSE) up -d --wait --wait-timeout 300

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=200

test:
	pnpm test

seed:
	./infra/scripts/seed.sh

up-gpu:
	./infra/seaweedfs/start-storage.sh
	$(COMPOSE) --profile gpu up -d --wait --wait-timeout 300 --scale ai-worker=0

compose-config:
	./infra/scripts/validate-compose.sh
