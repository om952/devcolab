FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY apps/ai-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/ai-service/app ./app

# Run as an unprivileged user.
RUN useradd --create-home --uid 1001 aiservice && chown -R aiservice:aiservice /app
USER aiservice

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
