env "d1" {
  dev = "sqlite://dev?mode=memory"
  migration {
    dir = "file://adapters/cloudflare/migrations"
  }
}

env "node" {
  dev = "sqlite://dev?mode=memory"
  migration {
    dir = "file://adapters/sql/migrations"
  }
}
