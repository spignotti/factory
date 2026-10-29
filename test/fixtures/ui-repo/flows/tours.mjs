// Recorded flow of the tours area: the list API still serves the Alps tour.
const res = await fetch(new URL("/api/tours", process.env.BASE_URL));
const tours = await res.json();
if (!Array.isArray(tours) || !tours.some((t) => t.name === "Alps")) {
  console.error(`flow tours: Alps tour missing in ${JSON.stringify(tours)}`);
  process.exit(1);
}
console.log("flow tours: ok");
