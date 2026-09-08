#include "NavigationMath.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

static int checks = 0;
static void close_to(double actual, double expected, double tolerance) {
    ++checks;
    if (!isfinite(actual) || fabs(actual - expected) > tolerance) {
        fprintf(stderr, "check %d: got %.12f, expected %.12f +/- %.12f\n",
                checks, actual, expected, tolerance);
        assert(0);
    }
}
static void undefined(double actual) { ++checks; assert(isnan(actual)); }

int main(void) {
    /* Analytic references for the specified R=6,371,000 m sphere. */
    close_to(dn_distance_m(0, 0, 0, 1), 111194.92664455874, 0.000001);
    close_to(dn_distance_m(36, 28, 37, 28), 111194.92664455874, 0.000001);
    close_to(dn_distance_m(36.7, 28.1, 36.7, 28.1), 0, 0.000001);
    close_to(dn_distance_m(0, 179.5, 0, -179.5), 111194.92664455874, 0.000001);
    close_to(dn_distance_m(0, 0, 0, 180), 20015086.79602057, 0.000001);
    close_to(dn_distance_m(89, 0, 90, 0), 111194.92664455874, 0.000001);
    close_to(dn_distance_m(90, -180, 90, 180), 0, 0.000001);
    close_to(dn_initial_bearing_deg(0, 0, 1, 0), 0, 0.000001);
    close_to(dn_initial_bearing_deg(0, 0, 0, 1), 90, 0.000001);
    close_to(dn_initial_bearing_deg(0, 0, -1, 0), 180, 0.000001);
    close_to(dn_initial_bearing_deg(0, 0, 0, -1), 270, 0.000001);
    close_to(dn_initial_bearing_deg(0, 179.5, 0, -179.5), 90, 0.000001);
    close_to(dn_initial_bearing_deg(0, -179.5, 0, 179.5), 270, 0.000001);
    undefined(dn_initial_bearing_deg(20, 30, 20, 30));
    undefined(dn_initial_bearing_deg(0, 0, 0, 180));
    undefined(dn_initial_bearing_deg(90, 0, 80, 10));
    undefined(dn_distance_m(91, 0, 0, 0));
    undefined(dn_distance_m(0, 181, 0, 0));
    undefined(dn_distance_m(NAN, 0, 0, 0));
    undefined(dn_distance_m(0, INFINITY, 0, 0));
    undefined(dn_initial_bearing_deg(0, 0, -91, 0));
    close_to(dn_mps_from_knots(1), 1852.0 / 3600.0, 1e-12);
    close_to(dn_knots_from_mps(1852.0 / 3600.0), 1, 1e-12);
    close_to(dn_knots_from_mps(0), 0, 0);
    close_to(dn_eta_seconds(12 * 1852, dn_mps_from_knots(6)), 2 * 3600, 1e-9);
    close_to(dn_eta_seconds(24 * 1852, dn_mps_from_knots(4)), 6 * 3600, 1e-9);
    close_to(dn_eta_seconds(1852, dn_mps_from_knots(0.5)), 2 * 3600, 1e-9);
    close_to(dn_eta_seconds(0, 0), 0, 0);
    undefined(dn_eta_seconds(1852, 0));
    undefined(dn_eta_seconds(1852, -1));
    undefined(dn_eta_seconds(-1, 2));
    undefined(dn_eta_seconds(NAN, 2));
    undefined(dn_eta_seconds(1852, NAN));
    undefined(dn_eta_seconds(INFINITY, 1));
    undefined(dn_mps_from_knots(-1));
    undefined(dn_knots_from_mps(-1));
    undefined(dn_knots_from_mps(INFINITY));

    /* Properties over a reproducible grid, including date-line crossings. */
    for (int i = 0; i < 500; ++i) {
        double a = -80.0 + fmod(i * 13.71, 160.0);
        double b = -179.0 + fmod(i * 27.81, 358.0);
        double c = -80.0 + fmod(i * 7.23 + 8.0, 160.0);
        double d = -179.0 + fmod(i * 31.17 + 9.0, 358.0);
        double distance = dn_distance_m(a, b, c, d);
        close_to(distance, dn_distance_m(c, d, a, b), 0.00001);
        ++checks;
        assert(distance >= 0 && distance <= 20015087.0);
        double bearing = dn_initial_bearing_deg(a, b, c, d);
        ++checks;
        assert(isfinite(bearing) && bearing >= 0 && bearing < 360);
        double knots = 0.5 + i / 10.0;
        close_to(dn_knots_from_mps(dn_mps_from_knots(knots)), knots, 1e-12);
        close_to(dn_eta_seconds(distance, dn_mps_from_knots(knots)),
                 distance / 1852.0 / knots * 3600.0, 1e-6);
    }
    printf("PASS: %d distance, bearing, unit and duration checks\n", checks);
    return 0;
}
