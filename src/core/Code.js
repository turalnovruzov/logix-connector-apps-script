/**
 * Returns the authentication method required by the connector.
 * @return {Object} AuthType configuration indicating no auth is required
 */
function getAuthType() {
  var cc = DataStudioApp.createCommunityConnector();
  return cc.newAuthTypeResponse().setAuthType(cc.AuthType.NONE).build();
}

/**
 * Required function for Looker Studio connectors
 */
function isAdminUser() {
  return false;
}

/**
 * Returns the user configurable options for the connector.
 * @param {Object} request Config request parameters.
 * @return {Object} Connector configuration to be displayed to the user.
 */
function getConfig(request) {
  var cc = DataStudioApp.createCommunityConnector();
  var config = cc.getConfig();

  config
    .newInfo()
    .setId("instructions")
    .setText("Select one district to include in your report.");

  const districtSelect = config
    .newSelectSingle()
    .setId("district")
    .setName("District")
    .setHelpText("Select the district you want to include");

  // Add all district options from our reusable list
  getDistrictsList().forEach(function (district) {
    districtSelect.addOption(
      config.newOptionBuilder().setLabel(district.label).setValue(district.id)
    );
  });

  return config.build();
}

/**
 * Returns the schema for the given request.
 * @param {Object} request Schema request parameters.
 * @return {Object} Schema for the given request.
 */
function getSchema(request) {
  var cc = DataStudioApp.createCommunityConnector();

  // Get district DB number from config params
  const districtDbNumber =
    request.configParams && request.configParams.district
      ? getDistrictDbNumber(request.configParams.district)
      : null;

  Logger.log("Getting schema for district DB number: " + districtDbNumber);

  // Pass district DB number to getFields
  return cc
    .newGetSchemaResponse()
    .setFields(getFields(districtDbNumber))
    .build();
}

/**
 * Returns the tabular data for the given request.
 * @param {Object} request Data request parameters.
 * @return {Object} Contains the schema and data for the given request.
 */
function getData(request) {
  var cc = DataStudioApp.createCommunityConnector();
  Logger.log(
    "getData function called with request: " + JSON.stringify(request)
  );

  // Performance tracking - start time
  const startTime = new Date();

  // Get district DB number
  const districtDbNumber = getDistrictDbNumber(request.configParams.district);
  Logger.log("Using district DB number: " + districtDbNumber);

  // Get requested fields
  const requestedFieldIds = request.fields.map((field) => field.name);
  const requestedFields = getFields(districtDbNumber).forIds(requestedFieldIds);

  Logger.log("Requested Fields: " + JSON.stringify(requestedFieldIds));
  Logger.log(`Number of fields requested: ${requestedFieldIds.length}`);

  // Check if caching is enabled
  const cachingEnabled = isCachingEnabled();
  Logger.log(`Caching is ${cachingEnabled ? "enabled" : "disabled"}`);

  let rows = [];
  let message = "";

  // If caching is enabled, try to get data from cache
  if (cachingEnabled) {
    // Generate a cache key based on district and requested fields
    const cacheKey = generateCacheKey(districtDbNumber, requestedFieldIds);

    // Try to get data from cache first
    let cachedData = getFromCache(cacheKey);
    let cacheNeedsUpdate = true;

    if (cachedData) {
      Logger.log("Found data in cache with key: " + cacheKey);

      // Check if cache is still valid (not expired)
      if (!isCacheExpired(cachedData.timestamp)) {
        Logger.log("Cache is still valid, using cached data");
        cacheNeedsUpdate = false;

        // Log performance metrics with cache hit
        logPerformance(
          startTime,
          cachedData.data,
          "Cache hit: Using cached data"
        );

        // Return the cached data
        return {
          schema: requestedFields.build(),
          rows: processApiData(cachedData.data, requestedFieldIds),
        };
      } else {
        Logger.log("Cache is expired, will fetch fresh data");
      }
    } else {
      Logger.log("No cached data found, will fetch fresh data");
    }
  }

  // If we reach here, we need to fetch fresh data
  const apiStartTime = new Date();
  Logger.log(`[TIMING] Starting API call to backend`);
  const apiResponse = fetchFromLogixApi(requestedFieldIds, districtDbNumber);
  const apiEndTime = new Date();
  const apiDuration = apiEndTime - apiStartTime;
  Logger.log(`[TIMING] API call: ${apiDuration}ms`);

  // Handle API errors
  if (!apiResponse.success) {
    Logger.log(`API error: ${apiResponse.error}`);

    // Log performance metrics
    logPerformance(
      startTime,
      null,
      `Execution completed with error: ${apiResponse.error}`
    );

    return {
      schema: requestedFields.build(),
      rows: [],
    };
  }

  // Process the API data for Looker Studio
  const processingStartTime = new Date();
  Logger.log(`[TIMING] Starting data processing for ${apiResponse.data.length} rows`);
  rows = processApiData(apiResponse.data, requestedFieldIds);
  const processingDuration = new Date() - processingStartTime;
  Logger.log(`[TIMING] Data processing: ${processingDuration}ms`);
  message = "Fetched fresh data from API";

  // Store the data in cache if caching is enabled
  if (cachingEnabled) {
    // Generate a cache key based on district and requested fields
    const cacheKey = generateCacheKey(districtDbNumber, requestedFieldIds);

    const cacheData = {
      data: apiResponse.data,
      timestamp: new Date().getTime(),
    };

    // Update cache with fresh data
    putInCache(cacheKey, cacheData);
    Logger.log("Stored fresh data in cache with key: " + cacheKey);
    message += " and updated cache";
  }

  // Log detailed timing breakdown
  const totalDuration = new Date() - startTime;
  const networkPercentage = Math.round((apiDuration / totalDuration) * 100);
  const processingPercentage = Math.round((processingDuration / totalDuration) * 100);
  const otherDuration = totalDuration - apiDuration - processingDuration;
  const otherPercentage = Math.round((otherDuration / totalDuration) * 100);
  
  Logger.log(`[TIMING] === PERFORMANCE BREAKDOWN ===`);
  Logger.log(`[TIMING] Total execution: ${totalDuration}ms`);
  Logger.log(`[TIMING] - API network time: ${apiDuration}ms (${networkPercentage}%)`);
  Logger.log(`[TIMING] - Data processing: ${processingDuration}ms (${processingPercentage}%)`);
  Logger.log(`[TIMING] - Other operations: ${otherDuration}ms (${otherPercentage}%)`);

  // Log performance metrics
  logPerformance(startTime, rows, message);

  // Return the response with correctly formatted data
  return {
    schema: requestedFields.build(),
    rows: rows,
  };
}

/**
 * Function to test the connector's getData functionality
 * @param {boolean} withCaching Optional parameter to enable/disable caching during test
 */
function test(withCaching) {
  // Save current caching state to restore later
  const originalCachingState = isCachingEnabled();

  // If withCaching parameter is provided, set caching accordingly for this test
  if (withCaching !== undefined) {
    setCachingEnabled(withCaching);
    Logger.log(
      `Test running with caching ${withCaching ? "enabled" : "disabled"}`
    );
  } else {
    Logger.log(
      `Test running with current caching setting: ${
        originalCachingState ? "enabled" : "disabled"
      }`
    );
  }

  // Mock request object similar to what Looker Studio would send
  const request = {
    configParams: {
      district: DISTRICTS.DEMO.id,
    },
    fields: [{ name: "account" }, { name: "amount" }, { name: "description" }],
  };

  Logger.log("Starting getData test...");

  try {
    // Call getData - all logging now happens inside getData
    const response = getData(request);
    Logger.log(`Test completed with ${response.rows.length} rows returned`);
  } catch (error) {
    Logger.log(`Test failed with error: ${error}`);
  } finally {
    // Restore original caching state if it was changed
    if (withCaching !== undefined && withCaching !== originalCachingState) {
      setCachingEnabled(originalCachingState);
      Logger.log(
        `Restored original caching state: ${
          originalCachingState ? "enabled" : "disabled"
        }`
      );
    }
  }
}
