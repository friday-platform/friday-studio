# LiteLLM Model Management

## Overview

LiteLLM is deployed in the `atlas-operator` namespace as a proxy that provides a unified API for multiple LLM providers. Model configuration is stored as a YAML file in **Google Secret Manager** (secret name: `litellm-config`).

Each environment has its own secret in its respective GCP project:

| Environment | GCP Project | Secret Name |
|---|---|---|
| Production | `tempest-production` | `litellm-config` |
| Sandbox | `tempest-sandbox` | `litellm-config` |

At pod startup, a `gsm-init` init container fetches the secret and mounts it at `/secrets/app/litellm-config`. LiteLLM reads the config once on boot — **changes require a pod restart** to take effect.

## Prerequisites

- `gcloud` CLI authenticated with access to the relevant GCP project
- `kubectl` configured with the correct cluster context
- Permissions: Secret Manager Secret Version Adder role on the `litellm-config` secret

## Adding, Updating, or Removing Models

### Step 1: Download the current config

```bash
# Sandbox (always test here first!):
gcloud secrets versions access latest \
  --secret=litellm-config \
  --project=tempest-sandbox > /tmp/litellm-config-sandbox.yaml

# Production:
gcloud secrets versions access latest \
  --secret=litellm-config \
  --project=tempest-production > /tmp/litellm-config-production.yaml
```

### Step 2: Edit the config

Open the downloaded file and modify the `model_list` section.

**To add a model**, append a new entry under the relevant provider section:

```yaml
model_list:
  # ... existing models ...

  - model_name: my-new-model          # name your application will use to call this model
    litellm_params:
      model: provider/model-id        # LiteLLM model identifier (see provider prefixes below)
      api_key: <api-key>              # reuse the existing key for that provider, or add a new one
```

**To update a model**, change its `model` field (e.g., point to a newer version).

**To remove a model**, delete its entire entry from the list.

#### Provider prefixes

| Provider | Prefix | Example |
|---|---|---|
| Anthropic | `anthropic/` | `anthropic/claude-sonnet-4-6` |
| OpenAI | `openai/` | `openai/gpt-4o` |
| Google Gemini | `gemini/` | `gemini/gemini-2.5-flash` |
| Groq | `groq/` | `groq/meta-llama/llama-4-maverick-17b-128e-instruct` |

> **Note:** Each environment uses **different API keys** for the same providers. Never copy keys between environments.

### Step 3: Upload the new config version

```bash
# Sandbox:
gcloud secrets versions add litellm-config \
  --project=tempest-sandbox \
  --data-file=/tmp/litellm-config-sandbox.yaml

# Production:
gcloud secrets versions add litellm-config \
  --project=tempest-production \
  --data-file=/tmp/litellm-config-production.yaml
```

### Step 4: Restart LiteLLM pods

The pods need to be restarted to pick up the new secret version.

> **WARNING:** Always verify your kubectl context before running this command. Running against the wrong cluster will restart pods in the wrong environment.

```bash
# Verify you're targeting the right cluster:
kubectl config current-context

# Sandbox:
kubectl rollout restart deployment/litellm-proxy -n atlas-operator \
  --context=tempest-sandbox

# Production:
kubectl rollout restart deployment/litellm-proxy -n atlas-operator \
  --context=tempest-production
```

There are 2 replicas with a PDB (`minAvailable: 1`), so the rolling restart causes **zero downtime**.

Wait for the rollout to complete (pods take ~3-5 minutes due to secret fetching and a 90-second readiness probe delay):

```bash
kubectl rollout status deployment/litellm-proxy -n atlas-operator --timeout=300s
```

### Step 5: Verify

```bash
# Check pods are running (2 replicas expected):
kubectl get pods -n atlas-operator -l app=litellm-proxy

# Check logs for config load errors:
kubectl logs -n atlas-operator -l app=litellm-proxy --tail=50

# Test the new model (replace with your model name):
curl http://litellm-proxy.atlas-operator.svc.cluster.local:4000/v1/models
```

## Currently Configured Models

| Model Name | Provider | Environments |
|---|---|---|
| `claude-opus-4-6` | Anthropic | Production, Sandbox |
| `claude-sonnet-4-6` | Anthropic | Production, Sandbox |
| `claude-sonnet-4-5` | Anthropic | Production, Sandbox |
| `claude-haiku-4-5` | Anthropic | Production, Sandbox |
| `meta-llama/llama-4-maverick-17b-128e-instruct` | Groq | Production, Sandbox |
| `moonshotai/kimi-k2-instruct-0905` | Groq | Production, Sandbox |
| `openai/gpt-oss-120b` | Groq | Production, Sandbox |
| `whisper-large-v3-turbo` | Groq | Production, Sandbox |
| `gpt-4o` | OpenAI | Production, Sandbox |
| `gemini-2.0-flash` | Google | Production, Sandbox |
| `gemini-2.5-flash` | Google | Production, Sandbox |
| `gemini-3-flash-preview` | Google | Production, Sandbox |
| `gemini-3-pro-preview` | Google | Production, Sandbox |
| `gemini-3.1-flash-image-preview` | Google | Sandbox only |

## Rolling Back

If something goes wrong, you can roll back to a previous config version:

```bash
# List available versions:
gcloud secrets versions list litellm-config --project=tempest-production

# Download a specific old version:
gcloud secrets versions access <VERSION_NUMBER> \
  --secret=litellm-config \
  --project=tempest-production > /tmp/litellm-config-rollback.yaml

# Re-upload it as the latest version:
gcloud secrets versions add litellm-config \
  --project=tempest-production \
  --data-file=/tmp/litellm-config-rollback.yaml

# Restart pods:
kubectl rollout restart deployment/litellm-proxy -n atlas-operator
```

## Important Notes

- **Always test in sandbox first** before updating production.
- **Always verify your kubectl context** before restarting pods — running against the wrong cluster is the most common mistake.
- The config file also contains `general_settings` (master key, database URL) and `litellm_settings` — **do not modify those** unless you know what you're doing.
- Old secret versions are preserved in GSM — you can always roll back.
- Pods take **3-5 minutes** to become ready after restart (gsm-init secret fetch + 90s readiness probe delay). Be patient.
- LiteLLM reference for model names and providers: https://docs.litellm.ai/docs/providers
