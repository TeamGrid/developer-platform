# TeamGrid MCP Prüfung der OpenAI Anforderungen

Stand: 2. Oktober 2026. Diese Analyse prüft die Entwicklerverbindung in ChatGPT
und die Bereitstellung ihrer Tools in Codex. Sie ist ein datierter Prüfbericht,
keine Freigabe für eine Production Änderung.

Die Verbindung ist in ChatGPT installiert und mit einem TeamGrid Konto verbunden,
aber ihr Toolkatalog ist leer. Zwei Aktualisierungsversuche scheiterten. Beim
beobachteten zweiten Versuch antwortete ChatGPTs eigener Abrufendpunkt mit HTTP
500 und `{"detail":{"retryable":true,"message":"Internal server error"}}`.
Damit ist der Abruffehler belegt. Die Antwort benennt weder eine fehlende
Berechtigung noch die technische Ursache beim MCP Abruf.

Eine isolierte, datenfreie Diagnoseverbindung reproduzierte den leeren OAuth
Katalog. Mit verdichteten Eingabeschemas importiert derselbe ChatGPT Host alle
208 Tools erfolgreich. Die Gegenprobe ohne Verdichtung scheitert wieder mit
HTTP 500. Diese Generator Korrektur ist lokal umgesetzt und qualifiziert;
die ursprüngliche Production Verbindung wurde noch nicht aktualisiert.

Der aktuelle Server enthält bereits die Korrektur für toolbezogene OAuth
Metadaten und die OpenAI OAuth Challenge im Toolergebnis. Ein erfolgreicher
nativer MCP Test in DE und erfolgreiche lokale Tests ersetzen dennoch keinen
erfolgreichen Aufruf aus der installierten OpenAI Verbindung. Die Gesamtintegration
ist deshalb noch nicht vollständig abgenommen.

## Umfang und geprüfte Quellen

Geprüft wurde der Developer Platform Stand
`90e6e1f9f10826972429f8282e05f7f71a69b682`, Paketversion 1.2.2, zusammen mit
dem OAuth Code und den Laufzeitbelegen des App Stands
`ecc29fa59982417048c65ba3a507289292efec00`. Die Verbindung verwendet
`https://mcp-de.teamgrid.app/mcp`. Die regionalen öffentlichen Discovery Dokumente
wurden zusätzlich in DE und US ohne Benutzercredential abgefragt.

Die maßgeblichen OpenAI Quellen wurden am Prüfdatum gelesen:

- [Authentication](https://developers.openai.com/plugins/build/auth) beschreibt
  Resource Discovery, PKCE, CIMD, Callback Identität und toolbezogene Zustimmung.
- [Reference](https://developers.openai.com/plugins/reference) definiert
  Toolmetadaten, Sicherheitsannotationen, Ergebnisverträge und Fehlerergebnisse.
- [Build your MCP server](https://developers.openai.com/plugins/build/mcp-server)
  beschreibt Server, Transport und die Trennung von Tools und optionaler UI.
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
  beschreibt Verbindung, Aktualisierung und Abnahme im tatsächlichen Host.

## Die vier Ebenen der Verbindung

1. Der öffentliche HTTPS Endpunkt muss für den OpenAI Host erreichbar sein.
2. OAuth muss eine gültige Verbindung zum ausgewählten Benutzer und Workspace
   erzeugen und erneuern können.
3. Der Host muss `initialize` und den vollständigen `tools/list` Ablauf ausführen,
   den Katalog übernehmen und die Tools dem Modell bereitstellen.
4. Ein konkretes `tools/call` muss mit aktuellen Scopes und TeamGrid
   Berechtigungen erfolgreich sein und ein gültiges Ergebnis zurückgeben.

Ein verknüpftes Konto beweist Ebene 2 nicht vollständig und beweist weder Ebene 3
noch Ebene 4. Eine Host Freigabeeinstellung kann nur vorhandene Tools steuern.
Sie ersetzt weder deren Discovery noch die OAuth Zustimmung. Diese Trennung
erklärt, weshalb ein verbundenes Konto und ein leerer Katalog gleichzeitig
auftreten können; sie bestimmt noch nicht die Ursache dieses konkreten Fehlers.

## OAuth Anforderungen und Befunde

| Anforderung für diese Verbindung | Geprüfter Befund | Grenze des Nachweises |
| --- | --- | --- |
| Öffentliche Resource und Authorization Server Metadata | Beide Dokumente liefern in DE und US HTTP 200. Die Resource enthält den genauen regionalen HTTPS Endpunkt mit `/mcp`. | Kein authentifizierter Toolabruf aus ChatGPT. |
| Exakte Übereinstimmung von Issuer und `authorization_servers` | Die regionalen Issuer stimmen einschließlich abschließendem `/` überein. | Bereits gespeicherte Host Identitäten wurden nicht aus Tokens ausgelesen. |
| Authorization Code mit PKCE S256 | Metadata enthält `S256`; der App Code erzwingt PKCE und Resource Bindung. Der native DE Test hat den Codeaustausch geprüft. | Der native Testclient ist nicht der ChatGPT Client. |
| RFC 9207 Issuer im Callback | Metadata enthält `authorization_response_iss_parameter_supported: true`; erfolgreiche und abgelehnte Zustimmungen liefern im Code `iss` und `state`. | Kein neuer ChatGPT Callback in dieser Prüfung. |
| CIMD als unterstützte Registrierung | DE veröffentlicht `client_id_metadata_document_supported: true`. Der Code validiert HTTPS Metadaten, Client Identität, Redirects und öffentliche Ziele. | US veröffentlichte dieses Flag zum Probezeitpunkt nicht; seine öffentliche ChatGPT Registrierung muss gesondert abgenommen werden. |
| Gemeinsame Token Auth Methode | TeamGrid unterstützt den öffentlichen PKCE Client mit `none`. Der Parser akzeptiert OpenAIs pluralen Methodenvertrag, auch wenn die alte singuläre Präferenz `private_key_jwt` lautet. | Keine Notwendigkeit für eine zusätzliche JWT Methode aus dem bloßen Beispiel ableiten. |
| Resource und Audience Bindung | Authorization und Token Pfad binden die genaue Resource. Jede MCP Anfrage prüft Issuer, Audience, Ablauf, Zelle und Grant über Introspection. | Der aktuelle ChatGPT Grant wurde nicht separat verwendet oder aus dem Browser extrahiert. |
| Ungültige Credentials werden abgewiesen | Ein unauthentifiziertes `initialize` liefert erwartungsgemäß 401 mit regionalem `WWW-Authenticate` und `resource_metadata`. Native API Tokens werden im Hosted MCP abgewiesen. | Der erwartete 401 Probeantwortstatus ist kein Verbindungsfehler. |
| Refresh und Widerruf | Der native DE Test prüft Rotation, Zurückweisung eines erneut verwendeten Refresh Tokens und Widerruf erfolgreich. | Host Wiederverbindung und minimale Zustimmung müssen zusätzlich mit ChatGPT getestet werden. |
| Serverseitige Berechtigungen bleiben wirksam | Gateway und API verwenden eine getrennte Delegation und aktuelle Workspace, Rollen, Sharing, Lock und Scope Regeln. Falscher Workspace wird nicht durch neue Scopes repariert. | Nicht alle Rollen, Membership und Lock Änderungen wurden in dieser Prüfung live ausgeführt. |

OpenAI bevorzugt CIMD, unterstützt aber auch andere eingerichtete OAuth Clients
und DCR. DCR ist bei funktionierendem CIMD keine zusätzliche Pflicht. Bei dem
gewählten DE Issuer mit RFC 9207 sind die stabile Client Identität
`https://chatgpt.com/oauth/client.json` und der stabile Redirect
`https://chatgpt.com/connector_platform_oauth_redirect` der passende Vertrag.
Die tatsächlich angezeigten Management Werte müssen genau übereinstimmen.
[Quelle](https://developers.openai.com/plugins/build/auth#client-registration).

## Anforderungen an Tools und ihre Zustimmung

Der Hosted Katalog umfasst 208 Tools mit 84 Reads und 124 Writes. Seine
Sichtbarkeit erteilt keine Ausführungsrechte. Die initiale Verbindung verwendet
`workspace:read`; Aufgabenlesen benötigt zusätzlich `tasks:read`. Der Code
prüft außerdem argumentabhängige Scopes, etwa für geschützte Finanzfelder.

| OpenAI Vertrag | Umsetzung und Prüfung |
| --- | --- |
| Name, verständlicher Titel, Beschreibung und `inputSchema` | Der Server registriert die überprüften Operationen mit konkreten Eingaben und liefert sie über den öffentlichen Discovery Handler. |
| `outputSchema` für `structuredContent` | Jede Registrierung besitzt einen konkreten Ausgabevertrag. Die Tests kompilieren Inputs und beide Ausgabevarianten aller 208 Tools. Erfolgreiche Ergebnisse werden zusätzlich validiert. |
| Authentifizierung je Tool | Hosted Discovery liefert top-level `securitySchemes` mit `oauth2` und Scopes sowie die identische `_meta.securitySchemes` Spiegelung. Der Test prüft den vollständigen paginierten HTTP Katalog. |
| Zusätzliche Zustimmung im Ergebnis | Für den verifizierten stabilen ChatGPT Client liefert fehlender Scope ein `isError: true` Ergebnis mit `_meta["mcp/www_authenticate"]`. Die Bearer Challenge enthält `error`, `error_description`, Scopes und Resource Metadata. Tatsächliche SDK Clients beider Protokollversionen werden getestet. |
| Keine Zustimmungseskalation bei anderen Verboten | Rollen, Sharing und falscher Workspace lösen keine breitere OAuth Zustimmung aus. Der Test prüft diese Trennung. |
| Vollständige Sicherheitsannotationen | `readOnlyHint`, `destructiveHint` und `openWorldHint` sind boolesch deklariert; `idempotentHint` beschreibt den Wiederholungsvertrag. Die in diesem Audit gefundenen falschen Read Metadaten wurden lokal korrigiert. |
| Vollständige Discovery | Der Katalog hat begrenzte Seiten mit `nextCursor`. Die Tests prüfen alle Tools, Seitengröße und Auth Metadaten. Die OpenAI Verbindung muss diese Discovery zusätzlich selbst erfolgreich übernehmen. |

Toolbezogene OAuth UI benötigt laut OpenAI sowohl deklarierte Auth Metadaten
als auch die passende Laufzeit Challenge. Der bereits gemergte
[PR 59](https://github.com/TeamGrid/developer-platform/pull/59) enthält diese
Korrektur. Die Runtime Belege für DE zeigen denselben Quellstand. Es wäre deshalb
falsch, den aktuellen Fehler pauschal mit noch fehlenden `securitySchemes` zu
erklären. [Quelle](https://developers.openai.com/plugins/build/auth#triggering-authentication-ui).

## Vorbereitete Metadatenkorrektur

Der Generator markierte zuvor alle Webhook, Einladungs und Automation Tools
als `openWorldHint: true`, auch reine Reads. Diese Reads rufen ausschließlich
begrenzte private Workspace Daten ab; sie kontaktieren keine gespeicherten
Webhook Ziele oder Einladungsempfänger. OpenAI unterscheidet dies ausdrücklich
von Zugriffen auf offene externe Entitäten.
[Quelle](https://developers.openai.com/plugins/reference#annotations).

Die lokale Korrektur setzt bei zehn solchen Reads `openWorldHint: false`.
Vier Beschreibungen von Kommentar und Einladungs Reads enthalten nicht mehr
den irreführenden Hinweis auf Benachrichtigungen. Outbound Mutationen behalten
ihre externe Sicherheitsdeklaration und ihren Hinweis auf mögliche
Benachrichtigungen. Toolnamen, Inputs, Outputs, Scopes und Runtime Rechte werden
dabei nicht verändert.

Der ergänzte HTTP Discovery Test prüft alle Read Annotierungen und die drei
erforderlichen booleschen Hinweise. Er stellt außerdem sicher, dass Webhook
Tests, Einladungsversand und Automation Erstellung ihre externe Deklaration
behalten. Diese Korrektur verbessert den Host Vertrag; sie ist keine belegte
Behebung des HTTP 500 Abruffehlers. Sie ist vorbereitet, nicht veröffentlicht.

## Reproduzierter OAuth Katalogimport und Schemaverdichtung

Am 2. Oktober wurde ein weiterer Production Refresh ab
`18:54:50.179Z` mit regionalen Ereignissen abgeglichen. Der initiale Probezugriff
erhielt den erwarteten 401. Tokenaustausch und Refresh lieferten HTTP 200.
Beide Abrufserien enthielten jeweils zehn authentifizierte MCP Antworten mit
HTTP 200; der ChatGPT Refresh endete trotzdem mit HTTP 500. Die vorhandenen
Production Ereignisse enthalten keine JSON RPC Methoden oder Antwortkörper.
Sie beweisen daher keinen erfolgreichen vollständigen JSON RPC Katalogimport.

Eine temporäre Diagnoseverbindung lieferte die öffentlichen Deskriptoren des
lokalen SDK. Sie hatte keinen API Client mit Datenzugriff und lehnte jeden
`tools/call` ab. Ein separater synthetischer OAuth Provider stellte ausschließlich
Tokens für diese Datenattrappe aus, mit PKCE, fester ChatGPT Client Identität,
exaktem Redirect, Resource Bindung und Refresh. Es wurden weder echte TeamGrid
Credentials noch Kundendaten an diesen Endpunkt weitergegeben.

| Kontrollfall im tatsächlichen ChatGPT Host | Ergebnis |
| --- | --- |
| 208 unveränderte Toolschemas mit `noauth` | Erstimport und Refresh erfolgreich; 84 Reads und 124 Writes sichtbar. |
| Derselbe datenfreie Katalog mit abgeschlossenem OAuth Flow und initial `workspace:read` | Leerer Katalog; der vollständige Refresh scheitert. |
| Vollständige `scopes_supported` statt minimaler Resource Metadata | Refresh bleibt erfolglos. |
| Ein Workspace Tool oder ein Aufgaben Tool mit zusätzlichen deklarierten Scopes | Jeweils erfolgreich, ohne Erweiterung des initialen Diagnose Grants. |
| Beide getrennten Hälften mit jeweils 104 Tools | Jeweils erfolgreicher Refresh. |
| 200 Tools; 201 Tools einschließlich des separat geprüften Workspace Tools | Erfolgreicher Refresh. |
| 207 oder 208 unveränderte Tools | Fehlgeschlagener Refresh. |
| Alle 208 Tools mit vier verdichteten Eingabeschemas | Erfolgreicher OAuth Refresh. |

Der entscheidende Vergleich wurde anschließend unter derselben erneuerten
synthetischen OAuth Verbindung wiederholt: verdichtet HTTP 200
(`3615.1925`), unverändert HTTP 500 (`3615.1937`), erneut verdichtet HTTP 200
(`3615.1940`). Das sind lokale Browser Request Identifikatoren zur Zuordnung,
keine serverübergreifenden Trace IDs. Der erfolgreiche Dialog zeigte wieder
84 Reads und 124 Writes.

Anschließend wurde in einer temporären ChatGPT Unterhaltung ausschließlich die
OAuth Diagnoseverbindung ausgewählt und einmal `teamgrid_workspace_get` mit
`{}` angefordert. Der Diagnoseendpunkt protokollierte um
`19:49:27.964Z` genau einen `tools/call`; die Host UI zeigte den Workspace
Aufruf und das erwartete Fehlerergebnis `diagnostic_catalog_only`. Damit ist
zusätzlich zum Import auch das Routing eines Modellaufrufs über MCP belegt.
Die Attrappe gibt bewusst keine Geschäftsantwort zurück; dieser Nachweis
ersetzt keinen autorisierten Production Read.

Die Änderung betrifft ausschließlich wiederholte Schemaabschnitte in vier
großen Eingaben. Der Generator ersetzt identische Abschnitte durch lokale
`$defs` und `$ref`. Er besucht nur tatsächliche Schema Positionen, erhält
Literale in `enum` und `default`, vermeidet Namenskollisionen und überspringt
Schemas mit Ankern, eigenen Dialekten oder anderen Referenzformen. Bounds,
Pflichtfelder, Rekursion und bestehende lokale Referenzen bleiben wirksam.

| Tool | Eingabeschema vorher / nachher, JSON Bytes |
| --- | --- |
| `teamgrid_task_recurrence_create` | 64.699 / 57.295 |
| `teamgrid_task_recurrence_update` | 61.426 / 54.022 |
| `teamgrid_task_recurrence_preview_input` | 61.245 / 53.841 |
| `teamgrid_task_recurrence_apply_task_template` | 58.405 / 51.001 |

In der Attrappe sinkt die Summe der neun `tools/list` JSON Ergebnisse von
2.038.137 auf 2.008.521 Bytes. Toolanzahl, Namen, Titel, Beschreibungen,
Ausgabeschemas, Auth Metadaten und Scopes sind im entscheidenden Vergleich
identisch. Der Produktionscode für Autorisierung und Geschäftsaktionen ändert
sich nicht. Der Befund belegt eine wirksame Korrektur des reproduzierten
Gesamtkatalog Imports; er benennt keine dokumentierte OpenAI Byte oder Tool
Obergrenze und beweist noch keinen Geschäftsread aus Production.

Ein weiterer Befund betrifft Wiederverbindungen: Nach einem erfolgreichen
Teilimport verlangte ChatGPT bei `Erneut verbinden` die Vereinigung der Scopes
seiner bereits importierten Tools. Nur die Attrappe wurde so erneut verbunden.
Eine Production Wiederverbindung darf deshalb nicht pauschal als minimaler
Read Grant beschrieben werden; die konkrete Scope Liste muss vor Zustimmung
geprüft werden. Ein normaler Refresh Token erweitert weiterhin keinen Grant.

Die MCP Spezifikation erlaubt ausdrücklich Unterschiede zwischen
`scopes_supported` und einer konkreten Challenge. Das minimale Resource
Dokument ist deshalb allein kein nachgewiesener Protokollverstoß.
[Quelle](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#protected-resource-metadata-discovery-requirements).

## Optionale Funktionen

Eine Widget UI, Standardtools namens `search` und `fetch`, ein Profiltool,
OIDC Benutzeridentität und Skills Import sind für diese Geschäftsverbindung
keine allgemeinen Voraussetzungen. Ihr Fehlen erklärt keinen leeren normalen
MCP Toolkatalog. `search` und `fetch` betreffen insbesondere einen anderen
Anwendungsfall für Company Knowledge.

Ein Profiltool kann die Kontenverwaltung verbessern; OpenAI erlaubt mehrere
Konten auch ohne dieses Tool. OIDC mit bestätigter E Mail und UserInfo wird
für Enterprise Domain Einschränkungen benötigt, wenn diese Funktion unterstützt
werden soll. Die Verwendung eines ID Token Hint bei erneuter Zustimmung ist
eine optionale Verbesserung. [Quelle](https://developers.openai.com/plugins/build/auth).

OpenAI stellt einen eigenen mTLS Clientnachweis bereit. Wenn der Proxy
Clientzertifikate prüft, muss er die dokumentierte OpenAI Kette und Identität
akzeptieren. Eine solche zusätzliche Prüfung oder eine IP Allowlist ersetzt
keine Benutzer OAuth Autorisierung. Die allgemeine Verbindung verlangt keine
neue Kunden API Key oder Service Account Freigabe.
[Quelle](https://developers.openai.com/plugins/build/auth#mutual-tls-mtls).

## Vorliegende Tests und Laufzeitbelege

- `npm run build`: erfolgreich auf dem geprüften Ausgangsstand.
- `npm run typecheck -w @teamgrid/mcp-server`: erfolgreich.
- `npx vitest run packages/mcp-server`: 17 Dateien und 335 Tests erfolgreich,
  auch nach der Metadatenkorrektur.
- `node scripts/generate-mcp-catalog.mjs --check`: erfolgreich nach Regeneration.
- Biome Prüfung des geänderten TypeScript Tests und `git diff --check`:
  erfolgreich.
- `npm run verify` nach Schemaverdichtung: erfolgreich, einschließlich
  61 Testdateien und 712 Tests, aller Builds und Typprüfungen, Contract und
  Generator Checks, Edge Runtime, Redaction und gepackter Installation.
- Der zusätzlich ergänzte Referenzschutz und drei Schema Semantiktests:
  erfolgreich; der Generator Check bleibt unverändert erfolgreich.
- `npm test` auf dem abschließenden Stand: 61 Testdateien und 713 Tests
  erfolgreich. Alle vier verdichteten Eingaben ergeben nach Expansion der
  neuen Referenzen exakt ihre bisherigen Schemas; die übrigen 204
  Eingabeschemas sind unverändert.
- [SDK PR60 CI](https://github.com/TeamGrid/developer-platform/actions/runs/37056161616):
  alle sechs Paketprüfungen auf Linux, macOS und Windows mit Node 22.14.0 und
  Node 24 sowie die Hosted MCP Image Prüfung erfolgreich für Quellstand
  `b52a0dd528652bcc4a79a602f84d0f997db60c2e`.
- Tatsächlicher ChatGPT Diagnoseaufruf: ein `tools/call` erreicht nach
  erfolgreichem OAuth Import den datenfreien Endpunkt und das erwartete
  Fehlerergebnis. Keine CLI oder Geschäftsoperation wurde dafür verwendet.
- [DE native Qualification](https://github.com/TeamGrid/teamgrid/actions/runs/37032566951):
  Code und PKCE, Refresh Rotation und Reuse, Widerruf, falsche Resource,
  Discovery, autorisierter Read und Write, Konflikt, Read Grant Write Verbot,
  Workspace Isolation und Cleanup erfolgreich.
- [DE Activation](https://github.com/TeamGrid/teamgrid/actions/runs/37033692631):
  Runtime Receipt für den geprüften SDK Stand und unveränderlichen Image Digest;
  Hosted MCP und autorisierte Writes aktiviert.
- [US native Qualification](https://github.com/TeamGrid/teamgrid/actions/runs/37035713280):
  erfolglos in der Phase `consent-full-synthetic-workspace`, nach Warten auf
  Browserzustimmung. Die nachfolgenden Prüfungen wurden nicht erfolgreich
  ausgeführt. Das ist kein nachgewiesener Protokollfehler und keine erfolgreiche
  US Abnahme.
- ChatGPT Tools Aktualisierung: zweimal sichtbar fehlgeschlagen, beim
  beobachteten zweiten Abruf HTTP 500 vom ChatGPT Backend. In diesem Codex Turn
  waren keine TeamGrid Toolfunktionen im angebotenen Toolkatalog vorhanden.

Die dokumentierte erste Production Aktivierung verwendete noch den Vorgänger.
Die neueren Runtime Receipts sind für den aktuellen DE Befund maßgeblich.
Paketversion 1.2.2, der Git SHA, der Image Digest und die in ChatGPT angezeigte
Pluginversion 1.0.0 sind unterschiedliche Identitäten. Eine Pluginversion allein
beweist keinen bestimmten laufenden Serverstand.

## Gezielte Korrektur und verbleibende Abnahme

Die regionale Zuordnung und der kontrollierte Host Vergleich sind abgeschlossen.
Als nächstes muss die korrigierte SDK Quelle den normalen Review und
Release Pfad durchlaufen. Die vollständige Produktionsverbindung muss nach dem
Rollout aktualisiert und mit einem echten Geschäftsread abgenommen werden.
Die Diagnose kopiert keine Tokens, Cookies, Authorization Header, Auth Codes
oder vollständigen Kundendaten in ihre Belege.

| Ergebnis des Abgleichs | Passende weitere Maßnahme |
| --- | --- |
| Keine Anfrage erreicht den regionalen Ingress | Host Verbindung, Ziel Resource, Erreichbarkeit und OpenAI Routing prüfen. Den beobachteten HTTP 500 mit Uhrzeit für OpenAI Support dokumentieren. |
| Discovery erreicht den Server, Credential wird abgewiesen | Den genauen OAuth Fehler prüfen; Issuer, Resource, Client Registrierung und Refresh Familie kontrollieren. Keine Scopes auf Verdacht erweitern. |
| Authentifiziertes `initialize` oder `tools/list` scheitert | Den konkreten Response und seine Protocol bzw. Schema Ursache reproduzieren und gezielt korrigieren. |
| Vollständiger Katalog wird erfolgreich ausgeliefert, Host verwirft ihn | Die exakt ausgelieferten Deskriptoren mit dem OpenAI Vertrag vergleichen. Katalogverarbeitung und Host Cache mit dem Response Nachweis eingrenzen. |

Nach einer korrigierten und qualifizierten Serverversion verlangt der
Entwicklerablauf ein erneutes Refresh und eine neue Unterhaltung mit aktivierter
Verbindung. Eine gelungene Verbindung muss mindestens diese Schritte nachweisen:

1. Der Host zeigt den vorgesehenen Toolkatalog nach erfolgreicher Discovery.
2. `teamgrid_workspace_get` wird mit `{}` tatsächlich als MCP Tool aufgerufen;
   sein Ergebnis entspricht dem freigegebenen Workspace.
3. Ein begrenzter Aufgabenread fordert bei Bedarf `tasks:read` an. Nach
   ausdrücklicher Zustimmung liefert er echte Aufgaben. Ablehnen lässt bereits
   freigegebene Reads nutzbar.
4. Ein erneuter Read nach Access Token Ablauf funktioniert über Refresh.
   Widerruf oder entfernte Berechtigungen werden beim nächsten Zugriff wirksam.
5. Eine ausdrücklich autorisierte reversible Testmutation liest ihren Zielstand,
   nutzt Workspace und Revision oder Idempotenz und prüft anschließend das
   Ergebnis. Ein reiner Read Request schreibt nichts.
6. Direkte und indirekte Anfragen, Folgefragen, negative Anfragen sowie falscher
   Workspace und veraltete Revision werden im tatsächlichen Host geprüft.

Für den ursprünglichen Aufgabenrequest gehört die Identifikation des
autorisierten aktuellen Benutzers vor den Assignee Filter. Die initialen
`workspace:read` Scopes allein reichen hierfür nicht. Falls die Verbindung
weiterhin keine Tools bereitstellt, wird genau dieser Fehler gemeldet; ein
Task CLI Aufruf ersetzt den angeforderten MCP Test nicht.

OpenAI beschreibt diese Host Tests ausdrücklich zusätzlich zum lokalen
Servertest. [Quelle](https://developers.openai.com/plugins/deploy/connect-chatgpt).
Ein Erfolg der Gesamtintegration wird erst nach diesen beobachteten Aufrufen
festgehalten. Produktionsänderungen folgen dem aktuellen App Release Runbook
mit exakten Artefakten; die bestehende Feature und Berechtigungsbaseline bleibt
dabei erhalten.
