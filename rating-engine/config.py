from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    redis_url: str = "redis://localhost:6379"

    # Redis Streams rating pipeline (replaces SQS). Stream key must match the
    # backend producer (backend/src/shared/queue/ratings.stream.ts).
    rating_stream_key: str = "allsports:ratings"
    rating_consumer_group: str = "rating-workers"
    # Reclaim messages stranded by a crashed consumer after this many ms idle.
    rating_claim_idle_ms: int = 60_000
    # A message that keeps failing is poison. After this many delivery attempts
    # it moves to the dead-letter stream instead of being reclaimed forever.
    rating_max_deliveries: int = 5
    rating_dead_letter_key: str = "allsports:ratings:dead"

    # Dev convenience: run the consumer in a background thread inside the API
    # process. In prod the consumer runs as its own process (`python consumer.py`),
    # so the API process sets this false.
    run_consumer_in_api: bool = True

    class Config:
        env_file = ".env"
        case_sensitive = False

settings = Settings()
