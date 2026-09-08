#include "NavigationMath.h"
#include <math.h>

static const double pi = 3.14159265358979323846;
static const double earth_radius_m = 6371000.0;
static double radians(double degrees) { return degrees * pi / 180.0; }
static int valid_coordinate(double latitude, double longitude) {
    return isfinite(latitude) && isfinite(longitude)
        && latitude >= -90.0 && latitude <= 90.0
        && longitude >= -180.0 && longitude <= 180.0;
}

double dn_distance_m(double lat1, double lon1, double lat2, double lon2) {
    if (!valid_coordinate(lat1, lon1) || !valid_coordinate(lat2, lon2)) return NAN;
    double p1 = radians(lat1), p2 = radians(lat2);
    double dp = p2 - p1, dl = radians(lon2 - lon1);
    double a = sin(dp / 2.0) * sin(dp / 2.0)
        + cos(p1) * cos(p2) * sin(dl / 2.0) * sin(dl / 2.0);
    a = fmin(1.0, fmax(0.0, a));
    return earth_radius_m * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
}

double dn_initial_bearing_deg(double lat1, double lon1, double lat2, double lon2) {
    if (!valid_coordinate(lat1, lon1) || !valid_coordinate(lat2, lon2)) return NAN;
    if (fabs(lat1) >= 90.0) return NAN; /* North reference undefined at poles. */
    double p1 = radians(lat1), p2 = radians(lat2), dl = radians(lon2 - lon1);
    double y = sin(dl) * cos(p2);
    double x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl);
    /* Coincident and antipodal points have no unique initial bearing. */
    if (hypot(x, y) < 1e-12) return NAN;
    return fmod(atan2(y, x) * 180.0 / pi + 360.0, 360.0);
}

double dn_knots_from_mps(double meters_per_second) {
    if (!isfinite(meters_per_second) || meters_per_second < 0.0) return NAN;
    return meters_per_second * 3600.0 / 1852.0;
}

double dn_mps_from_knots(double knots) {
    if (!isfinite(knots) || knots < 0.0) return NAN;
    return knots * 1852.0 / 3600.0;
}

double dn_eta_seconds(double distance_meters, double meters_per_second) {
    if (!isfinite(distance_meters) || distance_meters < 0.0
        || !isfinite(meters_per_second) || meters_per_second < 0.0) return NAN;
    if (distance_meters == 0.0) return 0.0;
    /* No invented ETA while stopped, or with an unavailable speed. */
    if (meters_per_second <= 0.0) return NAN;
    return distance_meters / meters_per_second;
}
