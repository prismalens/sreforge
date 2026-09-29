FROM python:3.12-slim
WORKDIR /app
# prometheus_client: service metrics (in-flight gauge, request counter, duration
# histogram) exposed on /metrics. Stdlib-only otherwise.
RUN pip install --no-cache-dir prometheus_client==0.21.1
COPY book_metadata_api.py .
EXPOSE 8080
CMD ["python", "book_metadata_api.py"]
