# C4 context

The diagram source is Mermaid and is stored in Git. [Architecture overview](README.md) repeats this diagram so the overview can be read on its own.

EditAgent is the system under design. People and external systems sit outside its trust boundary.

```mermaid
C4Context
title System context for EditAgent

Person(creator, "Creator", "Uploads raw footage and describes the edit in natural language")
Person(admin, "Admin", "Operates the deployment and reviews security-sensitive changes")

System(editagent, "EditAgent", "Perceives, plans, edits, renders, critiques and refines video through a modular monolith and workers")

System_Ext(llm, "LLM providers", "Hosted or local models that accept tool calls and structured output")
System_Ext(asset_providers, "Asset providers", "External stock-media and package sources used by later acquisition stories")
System_Ext(browser, "Web browser", "Untrusted client runtime for the Creator and Admin")

Rel(creator, browser, "Uses")
Rel(admin, browser, "Administers")
Rel(browser, editagent, "HTTPS", "UI and API calls, presigned uploads")
Rel(editagent, llm, "Tool calls and structured output", "HTTPS")
Rel(editagent, asset_providers, "Search and quarantine download", "HTTPS")
```

## Actors

| Actor | Relationship to EditAgent |
|---|---|
| Creator | Primary user. Uploads media, describes the result, reviews renders. |
| Admin | Operates the deployment and is the role that can perform administrative actions defined by Identity. |
| Web browser | Untrusted client. It is not part of the application trust zone. |
| LLM providers | External. Prompts are untrusted user content. Provider credentials stay in the application trust zone. |
| Asset providers | External. Nothing they return is trusted until a later Assets story quarantines and validates it. |

The AI agent is not a person. It is a secondary actor implemented inside EditAgent by the Agent module.
