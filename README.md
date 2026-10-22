# activemeter

Measure how much of each request is CPU before you move a Node server to active-CPU billing.

AWS Lambda Web Functions (launched Oct 12, 2026) bill active vCPU seconds plus memory for the life of the environment. Lambda Event Functions bill wall-clock duration times configured memory. Which one is cheaper depends on one number most teams have never measured: the share of each request spent on CPU instead of waiting.

`activemeter` starts your server with `AWS_LAMBDA_HTTP_ENDPOINT` set, drives each route in a mix file, reads the server's CPU time from `/proc/<pid>/stat`, and prices each route under both models with the rates in `prices.json`.

```
bash demo.sh           # 8 pass/fail checks against a bundled example server
bash demo.sh --break   # bills wall-clock time as CPU, which must fail
node activemeter.mjs --mix examples/mix.json --out report.json -- node examples/app.mjs
```

Sample run on the bundled example (10M requests/month, 1024 MB Event memory, us-east-1 rates checked 2026-10-22):

```
route       conc   reqs   in-flight ms   cpu ms/req   active   envs   event/mo   web/mo   cheaper
/db           16    400          122.0         0.25     0.2%      1     $22.33    $3.67       web
/render        1    143           21.0        20.42    97.3%      1      $5.50    $9.26     event
/mixed         8    168          145.9        15.05    10.3%      1     $26.32    $7.77       web
```

This is a proof of concept. Linux only, Node 20+, zero dependencies. The cost numbers are a model, not a bill. See AGENTS.md for the data shape, the assumptions behind the price model, known limits, and next steps.
