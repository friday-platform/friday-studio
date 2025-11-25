# Get the currently used golang install path (in GOPATH/bin, unless GOBIN is set)
ifeq (,$(shell go env GOBIN))
GOBIN=$(shell go env GOPATH)/bin
else
GOBIN=$(shell go env GOBIN)
endif

# Setting SHELL to bash allows bash commands to be executed by recipes.
SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

.PHONY: all
all: build

##@ General

.PHONY: help
help: ## Display this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Development

.PHONY: fmt
fmt: ## Run go fmt against code.
	go fmt ./...

.PHONY: vet
vet: ## Run go vet against code.
	go vet ./...

.PHONY: test
test: fmt vet ## Run tests.
	go test ./... -race -coverprofile cover.out

.PHONY: lint
lint: ## Run golangci-lint
	golangci-lint run ./...

##@ Build

.PHONY: build
build: fmt vet ## Build atlas-manager binary.
	go build -o bin/atlas-manager cmd/manager/main.go

.PHONY: run
run: fmt vet ## Run a controller from your host.
	go run ./cmd/manager

.PHONY: docker-build
docker-build: ## Build docker image for local testing.
	docker build -t atlas-operator:local .

##@ Local Development

.PHONY: local-env
local-env: ## Create local .env file for development
	@echo "Creating local .env file for development..."
	@cat > .env <<EOF
	DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres
	ORGANIZATION_ID=your-org-id-1,your-org-id-2
	RECONCILIATION_INTERVAL=30s
	NAMESPACE=atlas
	ARGOCD_NAMESPACE=argocd
	ENVIRONMENT=sandbox
	GIT_REPO_URL=git@github.com:tempestteam/tempest-kustomize.git
	GIT_TARGET_REVISION=HEAD
	LOG_LEVEL=debug
	HEALTH_CHECK_PORT=8080
	METRICS_PORT=8081
	WEBHOOK_ENABLED=true
	WEBHOOK_PORT=8082
	WEBHOOK_TOKEN=your-local-webhook-token
	EOF
	@echo "Created .env file. Please update with your actual values."

.PHONY: clean
clean: ## Clean build artifacts
	rm -rf bin/
	rm -f cover.out