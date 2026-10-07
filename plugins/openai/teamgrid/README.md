# TeamGrid integration draft

Work with TeamGrid projects, tasks, planning, content, CRM and workspace administration.

Publisher: Foundster Corporate Services FZCO. OpenAI business verification is approved; plugin approval is pending.
Support: support@teamgridapp.com

Connect one TeamGrid workspace through OAuth. The full business catalog contains 208 tools (83 reads and 125 writes). Current workspace roles, sharing, locks and separately approved scopes apply to every call. Native OAuth permission consent also bounds calls by the saved TeamGrid checkbox selection; OAuth cannot grant additional role permissions. An unqualified automation activation is rejected explicitly, and tool visibility is not execution availability. No API key belongs in this package or in chat.

## Data flow

The remote connector sends the selected tool name and arguments to https://mcp.teamgrid.app/mcp; the host receives the permitted TeamGrid response. Arguments and responses can contain workspace, project, task, contact, planning, time, content and file/export data, including personal data. An authorized write changes TeamGrid records. Returned data becomes available to the AI host under that host's account and data settings.

The proposed global gateway processes request and response payloads in Germany before routing to the workspace's DE or US cell. US regional storage therefore does not mean US-only processing. OAuth routing and browser state use private gateway storage with bounded lifetimes; existing TeamGrid records follow TeamGrid retention. This package contains no local executable, hooks or additional data destinations. Actual hosting, retention and MCP-specific legal disclosures must be confirmed before submission.

This is a generated, unqualified development package. Its proposed global endpoint is not deployed by this build. Server-readable privacy and account terms pages, including a separate AI integration disclosure supplement, are prepared but require deployment and verification. Read integrations/README.md in the source repository before testing or preparing a submission. This package is not ready to publish.
