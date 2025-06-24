#!/bin/bash

# load environment variables
set -a && source .env && set +a

# Required variables
required_vars=(
    "resourceGroupName"
    "location"
    "logAnalyticsWorkspaceName"
    "customLogAnalyticsTableName"
)

# Set the current directory to where the script lives.
cd "$(dirname "$0")"

# Function to check if all required arguments have been set
check_required_arguments() {
    # Array to store the names of the missing arguments
    local missing_arguments=()

    # Loop through the array of required argument names
    for arg_name in "${required_vars[@]}"; do
        # Check if the argument value is empty
        if [[ -z "${!arg_name}" ]]; then
            # Add the name of the missing argument to the array
            missing_arguments+=("${arg_name}")
        fi
    done

    # Check if any required argument is missing
    if [[ ${#missing_arguments[@]} -gt 0 ]]; then
        echo -e "\nError: Missing required arguments:"
        printf '  %s\n' "${missing_arguments[@]}"
        [ ! \( \( $# == 1 \) -a \( "$1" == "-c" \) \) ] && echo "  Either provide a .env file or all the arguments, but not both at the same time."
        [ ! \( $# == 22 \) ] && echo "  All arguments must be provided."
        echo ""
        exit 1
    fi
}

####################################################################################

# Check if all required arguments have been set
check_required_arguments

####################################################################################

#
# Create log analytics workspace
#
la_query=$(az monitor log-analytics workspace list --query "[?name=='$logAnalyticsWorkspaceName']")
if [ "$la_query" == "[]" ]; then
    echo -e "\nCreating Log Analytics workspace '$logAnalyticsWorkspaceName'"
    az monitor log-analytics workspace create \
        --resource-group ${resourceGroupName} \
        --workspace-name ${logAnalyticsWorkspaceName} \
        --location ${location} \
        --retention-time 30
else
    echo "Log Analytics workspace $logAnalyticsWorkspaceName already exists."
fi

#
# Create a custom table in the Log Analytics workspace
custom_table_query=$(az monitor log-analytics workspace table list --resource-group ${resourceGroupName} --workspace-name ${logAnalyticsWorkspaceName} --query "[?name=='$customLogAnalyticsTableName']")
if [ "$custom_table_query" == "[]" ]; then
    echo -e "\nCreating custom table '$customLogAnalyticsTableName' in Log Analytics workspace '$logAnalyticsWorkspaceName'"
    az monitor log-analytics workspace table create \
        --resource-group ${resourceGroupName} \
        --workspace-name ${logAnalyticsWorkspaceName} \
        --name $customLogAnalyticsTableName \
        --columns TimeGenerated=datetime Message=string \
        --retention-time 30
else
    echo "Custom table '$customLogAnalyticsTableName' already exists in Log Analytics workspace $logAnalyticsWorkspaceName."
fi


az monitor data-collection rule create --resource-group "myResourceGroup" --location "eastus" --name "myCollectionRule" --rule-file "C:\samples\dcrEx1.json"
