#ifndef DENIZ_ROTA_NAVIGATION_MATH_H
#define DENIZ_ROTA_NAVIGATION_MATH_H

/* Pure, portable navigation calculations. Angles are in degrees.
 * Spherical approximation, radius 6,371,000 m. Not a hazard-aware router.
 * NAN means invalid/undefined; callers must not display NAN as a value. */
#ifdef __cplusplus
extern "C" {
#endif
double dn_distance_m(double lat1, double lon1, double lat2, double lon2);
double dn_initial_bearing_deg(double lat1, double lon1, double lat2, double lon2);
double dn_knots_from_mps(double meters_per_second);
double dn_mps_from_knots(double knots);
double dn_eta_seconds(double distance_meters, double meters_per_second);
#ifdef __cplusplus
}
#endif
#endif
