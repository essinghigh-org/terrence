const req = new Request("http://localhost/api/v2/tokens", {
  method: "POST",
  headers: {
     "authorization": "Bearer dummy-token",
     "content-type": "application/vnd.api+json"
  }
});
console.log(req.headers.get("authorization"));
