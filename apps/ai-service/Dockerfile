FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY apps/ai-service/requirements.txt .
# --require-hashes: every package is pinned to an exact version and hash, so a
# rebuild months from now installs byte-identical dependencies instead of
# silently resolving a newer langchain/langgraph. Fails loudly if the lock is
# incomplete. Regenerate with the uv command at the top of requirements.in.
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY apps/ai-service/app ./app

# Run as an unprivileged user.
RUN useradd --create-home --uid 1001 aiservice && chown -R aiservice:aiservice /app
USER aiservice

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
