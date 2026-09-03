#!/usr/bin/env bash
#
# Capture the digest of every base image and rewrite the pins.  (Audit F-150)
#
# `FROM node:22.11-alpine` and `image: certbot/certbot:v2.11.0` name a TAG, and
# a tag is a mutable pointer. Docker Hub can retag `22.11-alpine` at any time —
# routinely, for a base-OS CVE patch, and not routinely if the namespace is ever
# compromised. Either way the next `docker compose build` on a fresh host pulls
# different bytes than the last one, with nothing in git recording the change.
# That is the supply-chain half of reproducibility: the lockfile pins our npm
# tree exactly (F-102) while the layer underneath it floats.
#
# A digest is content-addressed, so `name:tag@sha256:…` is the same bytes
# forever. The tag stays for readability; the digest is what Docker resolves.
#
# This script must run WHERE THE IMAGES ARE — it reads digests from the local
# daemon rather than the network, so it cannot be run from a sandbox and does
# not need registry credentials.
#
#   bash tools/pin-image-digests.sh            # show what would change
#   bash tools/pin-image-digests.sh --write    # rewrite the files
#
# After a bump: change the TAG by hand, `docker compose pull`, re-run with
# --write, and commit both. The digest is the record of what you actually
# shipped, which is the point.
#
# ONE CAVEAT WORTH UNDERSTANDING BEFORE YOU COMMIT A PIN.
#
# If a tag has to be `docker pull`ed before this script can resolve it, the
# digest you get is whatever that tag points to TODAY — which is not necessarily
# the bytes inside the images currently running. Pinning it is therefore a
# FORWARD pin: it fixes what the NEXT build will use, and that may differ from
# what is deployed right now. That is the correct outcome (the whole point is to
# stop the base floating), but it means applying a pin is not a no-op. Rebuild
# and run the deploy verification afterwards rather than assuming nothing moved.
set -uo pipefail

WRITE=0
[ "${1:-}" = "--write" ] && WRITE=1

command -v docker >/dev/null 2>&1 || { echo "docker not found — run this on the deployment host." >&2; exit 2; }

# file : tag  (the tag as it appears today, without any existing @sha256)
TARGETS=(
    "Dockerfile.backend:node:22.11-alpine"
    "Dockerfile.frontend:node:22.11-alpine"
    "Dockerfile.frontend:nginxinc/nginx-unprivileged:1.27-alpine"
    "docker-compose.yml:certbot/certbot:v2.11.0"
)

# Resolve each distinct tag ONCE, and reuse that answer for every file that
# names it. node:22.11-alpine appears in both Dockerfiles; resolving it twice
# invites the two files to pin DIFFERENT digests if the tag is retagged between
# the two `docker image inspect` calls — two copies of a pin that drift, which
# is the failure this whole script exists to prevent, reintroduced by the fix.
declare -A RESOLVED=()

resolve_digest() {
    local tag="$1"
    if [ -n "${RESOLVED[$tag]:-}" ]; then printf '%s' "${RESOLVED[$tag]}"; return 0; fi

    # An image can be PRESENT with an empty .RepoDigests — that happens when it
    # was built locally or loaded from a tarball rather than pulled from a
    # registry. `{{index .RepoDigests 0}}` then fails with an index error, and
    # the old code swallowed it and printed "not pulled locally", which sends
    # the operator to `docker pull` for an image they already have. Distinguish
    # the two, because the remedy is genuinely different.
    if ! docker image inspect "$tag" >/dev/null 2>&1; then
        # This fires even for a base image both Dockerfiles obviously build
        # FROM, and that is not a contradiction: BuildKit (the default builder
        # since Docker 23) pulls base images into the BUILD CACHE, not into the
        # image store that `docker image inspect` reads. So a tag can be in
        # active use on this host and still be absent here. `docker pull`
        # populates the image store and makes it resolvable.
        echo "MISS  $tag is not in the local image store." >&2
        echo "      (Normal with BuildKit: it caches base images outside the image store," >&2
        echo "       so this says nothing about whether your builds use it.)" >&2
        echo "      Run: docker pull $tag" >&2
        return 1
    fi
    local d
    d=$(docker image inspect "$tag" --format '{{range .RepoDigests}}{{.}}{{"\n"}}{{end}}' 2>/dev/null | head -1 | sed 's/.*@//')
    if [ -z "$d" ]; then
        echo "MISS  $tag is present but carries no registry digest (built locally, or" >&2
        echo "      loaded from a tarball). Re-fetch it so a digest exists: docker pull $tag" >&2
        return 1
    fi
    RESOLVED[$tag]="$d"
    printf '%s' "$d"
}

# Is this tag pinned on a REAL FROM / image: line — as opposed to appearing in a
# comment? The first version of this check was a bare `grep -F "$tag@sha256:"`,
# and Dockerfile.backend carries a comment reading
#     # then change this line to `FROM node:22.11-alpine@sha256:…`
# which matched. The script reported "already digest-pinned" and skipped a file
# that was not pinned at all — a false OK, and the single worst outcome for a
# supply-chain tool, because it reports success while leaving the hole open.
# Same self-match trap this repo's TEST suite has hit repeatedly; the lesson
# evidently had not reached the tooling.
is_pinned() {
    local file="$1" tag="$2"
    grep -Eq "^[[:space:]]*(FROM|image:)[[:space:]]+${tag//\//\\/}@sha256:" "$file"
}

# Does this tag appear on a real FROM / image: line at all?
has_tag() {
    local file="$1" tag="$2"
    grep -Eq "^[[:space:]]*(FROM|image:)[[:space:]]+${tag//\//\\/}([[:space:]]|\$)" "$file"
}

changed=0
missing=0
for entry in "${TARGETS[@]}"; do
    file="${entry%%:*}"
    tag="${entry#*:}"
    [ -f "$file" ] || { echo "SKIP  $file not found"; continue; }

    if is_pinned "$file" "$tag"; then
        echo "OK    $file  $tag is already digest-pinned"
        continue
    fi

    if ! has_tag "$file" "$tag"; then
        echo "STALE $file  no FROM/image: line names $tag any more — update TARGETS" >&2
        continue
    fi

    digest=$(resolve_digest "$tag") || { missing=1; continue; }

    echo "PIN   $file  $tag@$digest"
    changed=1
    if [ "$WRITE" = "1" ]; then
        # Only on FROM / image: lines, so a tag mentioned in prose stays prose.
        tmp=$(mktemp)
        sed -E "s#^([[:space:]]*(FROM|image:)[[:space:]]+)${tag//\//\\/}([[:space:]]|\$)#\1${tag//\//\\/}@${digest}\3#" "$file" > "$tmp"
        if cmp -s "$file" "$tmp"; then
            echo "      (no FROM/image: line matched — check the tag spelling)" >&2
            rm -f "$tmp"
        else
            mv "$tmp" "$file"
        fi
    fi
done

if [ "$missing" = "1" ]; then
    echo >&2
    echo "One or more images could not be resolved — NOTHING above is a complete answer." >&2
    echo "Pull the images named above and re-run before using --write." >&2
    exit 1
elif [ "$changed" = "0" ]; then
    echo; echo "Nothing to do — every base image is already pinned by digest."
elif [ "$WRITE" = "0" ]; then
    echo; echo "Dry run. Re-run with --write to apply, then commit the change."
else
    echo; echo "Written. Verify with:  git diff -- Dockerfile.backend Dockerfile.frontend docker-compose.yml"
    echo "Then rebuild:            bash deploy.sh"
fi
