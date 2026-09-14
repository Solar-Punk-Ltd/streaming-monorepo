# ethisstream.eth.limo (msrs-client deployment) — UI observations 2026-09-11

Logged in as admin@ethis. Routes (hash router):
- #/            Browse streams: search box, grid of stream cards (thumbnail, duration badge, name).
- #/manage      My Streams: same grid, each card has Pin / Edit / Delete icon buttons; "Create New Stream" button at bottom.
- #/create      Create form: Stream Name* (0/100), Description* (0/500), Tags (add, max 10), Media Type radio (Video Stream | Audio Only),
                Upload Thumbnail (max 5MB, file input), Scheduled Start Time* (datetime-local). Buttons: Cancel, Preview (primary).
- #/edit/<ownerAddress>/<uuid>   Edit form: same fields minus Media Type and Scheduled Start; thumbnail shows existing swarm ref.
- #/watch/video/<ownerAddress>/<uuid>   Player + collapsible details (title, Description) + chat with emoji reactions and message box.
- #/stamps      "Swarm Stamp Manager": Connect MetaMask, bulk overview (26 stamps, 26 active, soonest expiry), extension slider 1..365 days,
                cost in BZZ, "Top Up All (N days)".
- Menu (username button): Browse streams, My Streams, My Stamps, Log out.

Stream identity in URLs: <ownerAddress (EOA, checksummed)>/<uuid v4>.
Network: all reads via gateway proxy https://ethis.beebridge.buzz/read/bzz/<ref>/ and /read/soc/<owner>/<id>. MetaMask SDK loaded.
No dedicated admin backend observed; the client talks to Swarm directly (through the proxy).
