.DEFAULT_GOAL := help

COMPOSE ?= docker compose

.PHONY: help up down logs test seed up-gpu compose-config staging-config

help:
	@printf '%s\n' \
		'make up             Start the stack only after host isolation is verified' \
		'make down           Stop the development stack' \
		'make logs           Follow service logs' \
		'make test           Run the workspace test suite' \
		'make seed           Check Postgres and Redis, and create the development bucket' \
		'make up-gpu         Start the stack with the NVIDIA profile for the AI worker' \
		'make compose-config Validate the default Compose file and the gpu profile' \
		'make staging-config Validate staging Compose when its environment is already exported'

up:
	./infra/seaweedfs/secure-up.sh compose.yaml

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=200

test:
	pnpm test

seed:
	./infra/scripts/seed.sh

up-gpu:
	COMPOSE_PROFILES=gpu ./infra/seaweedfs/secure-up.sh compose.yaml

compose-config:
	./infra/scripts/validate-compose.sh

staging-config:
	./infra/scripts/staging-preflight.sh --compose
