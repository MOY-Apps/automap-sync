# automap-sync - the Python sender in a minimal image: no shell, no package manager,
# runs as a non-root user, reads its settings from the environment and exits.
#
#   docker build -f docker/Dockerfile -t automap-sync .        (from senders/)
#   docker run --rm --pull always --env-file automap.env ghcr.io/moy-apps/automap-sync:1
#
# Tags: :1.0.0 exact, :1.0 and :1 move with compatible releases. Images are signed with
# cosign and carry an SBOM (.github/workflows/release.yml in the public repository).
FROM gcr.io/distroless/python3-debian12:nonroot
ARG VERSION=1.0.0
LABEL org.opencontainers.image.title="automap-sync" \
      org.opencontainers.image.description="Pushes Jira automation rules to Automation Map; the Atlassian token stays with you" \
      org.opencontainers.image.vendor="MOY Apps" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="LicenseRef-MOY-Apps-Automation-Map" \
      org.opencontainers.image.source="https://github.com/moy-apps/automap-sync"
COPY --chown=nonroot:nonroot python/automap_sync.py /app/automap_sync.py
USER nonroot
# -I: isolated mode - ignores PYTHON* variables and the current directory on sys.path
ENTRYPOINT ["python3", "-I", "/app/automap_sync.py"]
