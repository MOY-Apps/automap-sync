# automap-sync - the Python sender in a minimal image: no shell, no package manager,
# runs as a non-root user, reads its settings from the environment and exits.
#
#   docker build -f docker/Dockerfile -t automap-sync .        (from senders/)
#   docker run --rm --pull always --env-file automap.env ghcr.io/moy-apps/automap-sync:1
#
# Tags: :1.3.0 exact, :1.3 and :1 move with compatible releases - the Python sender's
# VERSION, which is what the receiver sees (X-Automap-Sender: python/1.3.0), not the
# repository tag. Images are signed with cosign and carry an SBOM
# (.github/workflows/release.yml in the public repository). The base image is pinned by
# digest; move it on purpose, with the same digest in every build.
FROM gcr.io/distroless/python3-debian12:nonroot@sha256:7d1042ce588ab97019fe95c24ffca7bc5a82ccdac572511d5e09bda4435c89c5
ARG VERSION=1.3.0
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
